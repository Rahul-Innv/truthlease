import { expect, test } from "@playwright/test";

/**
 * The agent front door, driven through its human-readable page: every button makes
 * the same HTTP call an agent would, and the transcript shows the raw JSON.
 *
 * The rate limit is 30 requests/minute per client, so the plan poll is spaced out.
 */
test.describe("agent front door", () => {
  test.beforeEach(async ({ request }) => {
    // Start from the preset run in "confirming" so the expected total does not depend on earlier specs.
    const res = await request.post("/api/reset");
    expect(res.ok()).toBe(true);
  });

  test("send request, confirm, read the plan until proposed", async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto("/agent");
    await expect(page.getByText("Agent front door · Demo suppliers · Local rules · Simulated orders")).toBeVisible();
    await expect(page.getByRole("link", { name: "Console", exact: true })).toHaveAttribute("href", "/");
    await expect(page.getByLabel("Request text")).toHaveValue(/Dinner for 60 hackathon attendees/);

    const transcript = page.getByTestId("transcript");
    const latest = page.getByTestId("exchange").first();

    // 1. Send request: nothing missing, so the next action is confirm.
    await page.getByRole("button", { name: "Send request", exact: true }).click();
    await expect(latest).toContainText("POST /api/agent/request");
    await expect(latest).toContainText('"nextAction": "confirm"');
    await expect(latest).toContainText('"missing": []');
    await expect(latest).toContainText('"assumptionsApplied"');

    // 2. Confirm: the market opens and the run moves to collecting.
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(latest).toContainText("POST /api/agent/confirm");
    await expect(latest).toContainText('"phase": "collecting"');

    // 3. Read plan until the market has cleared.
    await expect(async () => {
      await page.getByRole("button", { name: "Read plan", exact: true }).click();
      await expect(latest).toContainText("GET /api/agent/plan");
      await expect(latest).toContainText('"phase": "proposed"', { timeout: 2_000 });
    }).toPass({ intervals: [2_500], timeout: 60_000 });

    // The raw JSON carries cents; the line above it formats the total.
    await expect(latest).toContainText('"totalCents": 78440');
    await expect(latest).toContainText('"approvalRequired": true');
    await expect(transcript).toContainText("$784.40");
    await expect(transcript).toContainText("Fictional demo catalog");
    await expect(transcript).toContainText("Simulated orders");
  });

  test("an agent cannot approve: the endpoint answers 403 approval_requires_organizer", async ({ request }) => {
    test.skip(process.env.CLEARING_AGENT_CAN_APPROVE === "true", "agent approval is enabled in this environment");
    const res = await request.post("/api/agent/approve", { data: { planRevision: 1, idempotencyKey: "e2e-approve-denied" } });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("approval_requires_organizer");
  });

  test("the manifest is machine-readable and labelled", async ({ request }) => {
    const res = await request.get("/api/agent");
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest.name).toBe("Clearing");
    expect(manifest.simulated).toBe(true);
    expect(manifest.labels).toMatchObject({ supply: "Fictional demo catalog", execution: "Simulated orders" });
    expect(manifest.endpoints.map((e: { path: string }) => e.path)).toContain("/api/agent/plan");
  });
});
