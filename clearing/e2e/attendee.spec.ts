import { expect, test, type Browser, type Page } from "@playwright/test";
import { briefAside, getRun, historyCount, resetViaApi, shot, valueOf, waitForPhase, waitForServerPhase, watchConsole, type ConsoleWatch } from "./helpers";

/**
 * Attendee opt-in (P1): the organizer creates a public link in the console, two people answer
 * on phone-sized screens in separate browser contexts (separate storage, so separate respondents),
 * the console's counts update live, and the organizer applies them to the requirements.
 */
test.describe.configure({ mode: "serial" });

const DISCLAIMER = "Your answer only helps the organizer plan quantities. It is not an order, a reservation, or a payment.";

async function phone(browser: Browser, url: string): Promise<{ page: Page; watch: ConsoleWatch; close(): Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const watch = watchConsole(page);
  await page.goto(url);
  return { page, watch, close: () => context.close() };
}

async function expectPublicOnly(page: Page): Promise<void> {
  await expect(page.getByText(DISCLAIMER)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dinner");
  await expect(page.getByText("food ready by 6:30 PM", { exact: false })).toBeVisible();
  // No organizer surface: no links (to the console or elsewhere), no money, no plan or approval controls.
  await expect(page.getByRole("link")).toHaveCount(0);
  await expect(page.getByText(/\$\s?\d/)).toHaveCount(0);
  await expect(page.getByText(/budget|approve|offer/i)).toHaveCount(0);
  // Readable at 390 px: nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

test("attendee opt-in: link, two phone respondents, live counts, apply to requirements", async ({ page, browser, request }) => {
  test.setTimeout(120_000);
  await resetViaApi(request);
  const consoleWatch = watchConsole(page);

  // ---- 1. Organizer creates the link -----------------------------------------------------------
  await page.goto("/");
  await waitForPhase(page, "confirming");
  const brief = briefAside(page);
  const panel = brief.locator("section").filter({ has: page.getByRole("heading", { name: "Attendee opt-in" }) });
  await expect(panel.getByText("an answer is not an order or a payment", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Create attendee link" }).click();
  const linkBox = panel.getByLabel("Attendee link");
  await expect(linkBox).toHaveValue(/^http:\/\/[^/]+\/attend\/[a-f0-9]{48}$/);
  const url = await linkBox.inputValue();
  const token = url.split("/attend/")[1]!;
  const apply = panel.getByRole("button", { name: "Apply counts to requirements" });
  await expect(apply).toBeDisabled();
  await expect(panel.getByText("Available after the first response.")).toBeVisible();
  await expect(valueOf(panel, "Responses")).toHaveText("0");

  // ---- 2. The public API exposes only the event summary ----------------------------------------
  const pub = await request.get(`/api/attend/${token}`);
  expect(pub.ok()).toBe(true);
  const view = await pub.json();
  expect(Object.keys(view).sort()).toEqual(["enabled", "eventDate", "objective", "readyByLocal", "summary", "timezone", "venueName"]);
  expect(JSON.stringify(view)).not.toMatch(/budget|plan|offer|run_/i);
  expect((await request.get(`/api/attend/${"0".repeat(48)}`)).status()).toBe(404);
  const bogus = await request.post(`/api/attend/${"0".repeat(48)}`, { data: { respondentId: "e2e-bogus-0001", preference: "vegetarian", partySize: 1 } });
  expect(bogus.status()).toBe(404);

  // ---- 3. Respondent A (pointer): vegetarian, party of 2 ----------------------------------------
  const a = await phone(browser, url);
  await expectPublicOnly(a.page);
  await a.page.getByText("Vegetarian", { exact: true }).click();
  await expect(a.page.getByRole("radio", { name: "Vegetarian" })).toBeChecked();
  await a.page.getByRole("button", { name: "More people" }).click();
  await expect(a.page.getByLabel("Party size 2")).toBeVisible();
  await a.page.getByRole("button", { name: "Submit" }).click();
  await expect(a.page.getByText("Thanks, your answer is saved.")).toBeVisible();
  await expect(a.page.getByText("Vegetarian · 2 people")).toBeVisible();
  await expect(a.page.getByRole("button", { name: "Change my answer" })).toBeVisible();
  await shot(a.page, "attendee-phone-saved");

  // A reload keeps the same respondent: the confirmation comes back from this device's storage.
  await a.page.reload();
  await expect(a.page.getByText("Vegetarian · 2 people")).toBeVisible();

  // ---- 4. Respondent B (keyboard only): flexible, party of 3 ------------------------------------
  const b = await phone(browser, url);
  await expectPublicOnly(b.page);
  await expect(b.page.getByText("1 answer · 2 people", { exact: false })).toBeVisible();
  await b.page.keyboard.press("Tab"); // first radio
  await expect(b.page.getByRole("radio", { name: "Vegetarian" })).toBeFocused();
  await b.page.keyboard.press("ArrowRight"); // moves to and selects Flexible
  await expect(b.page.getByRole("radio", { name: "Flexible" })).toBeChecked();
  await b.page.keyboard.press("Tab"); // Fewer people
  await b.page.keyboard.press("Tab"); // More people
  await expect(b.page.getByRole("button", { name: "More people" })).toBeFocused();
  await b.page.keyboard.press("Enter");
  await b.page.keyboard.press("Enter");
  await expect(b.page.getByLabel("Party size 3")).toBeVisible();
  await shot(b.page, "attendee-phone-form");
  await b.page.keyboard.press("Tab"); // Submit
  await expect(b.page.getByRole("button", { name: "Submit" })).toBeFocused();
  await b.page.keyboard.press("Enter");
  await expect(b.page.getByText("Thanks, your answer is saved.")).toBeVisible();
  await expect(b.page.getByText("Flexible · 3 people")).toBeVisible();

  // ---- 5. Console counts update live; apply them ------------------------------------------------
  await expect(valueOf(panel, "Responses")).toHaveText("2");
  await expect(valueOf(panel, "People")).toHaveText("5");
  await expect(valueOf(panel, "Vegetarian")).toHaveText("2");
  await expect(valueOf(panel, "Flexible")).toHaveText("3");
  await expect(apply).toBeEnabled();
  await expect(panel.getByText("Sets headcount to 5 and vegetarian minimum to 2.", { exact: false })).toBeVisible();
  await expect(panel.getByText("will need", { exact: false })).toBeVisible();
  await shot(page, "attendee-console-counts");

  const before = await getRun(request);
  await apply.click();
  await expect(brief.getByText("5 guests", { exact: true })).toBeVisible();
  await expect(brief.getByText("2 vegetarian", { exact: true })).toBeVisible();
  await expect(brief.getByText("Counts applied from 2 attendee responses")).toBeVisible();
  await expect(apply).toBeDisabled();
  await expect(panel.getByText("Requirements already match: 5 guests, 2 vegetarian.")).toBeVisible();

  // The run was in confirming, so applying only edits the requirements (no plan yet to repair).
  expect(before.phase).toBe("confirming");
  const after = await waitForServerPhase(request, ["confirming", "disrupted", "repairing", "needs_approval", "no_feasible_plan"]);
  expect(after.phase).toBe("confirming");
  expect(after.requirements?.headcount).toBe(5);
  expect(after.requestVersion).toBe(before.requestVersion + 1);
  await waitForPhase(page, "confirming");
  expect(await historyCount(page, "attendee.applied")).toBe(1);
  expect(await historyCount(page, "attendee.responded")).toBe(2);
  expect(await historyCount(page, "attendee.link_created")).toBe(1);
  await shot(page, "attendee-console-applied");

  a.watch.expectClean();
  b.watch.expectClean();
  consoleWatch.expectClean();
  await a.close();
  await b.close();
});
