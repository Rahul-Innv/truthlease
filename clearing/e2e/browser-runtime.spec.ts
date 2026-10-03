import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  SCRATCH,
  approveButton,
  banner,
  confirmButton,
  disruptionsSection,
  historyTotal,
  orderRow,
  ordersSection,
  phaseChip,
  planAside,
  selection,
  valueOf,
  watchConsole,
  type Phase,
} from "./helpers";

/**
 * Browser runtime (NEXT_PUBLIC_CLEARING_RUNTIME=browser): the whole organizer journey runs in the
 * page against localStorage, with no API calls at all. Runs only against a browser-runtime build
 * (detected by /api/status answering 501 server_mode_disabled) and skips otherwise.
 *
 *   NEXT_PUBLIC_CLEARING_RUNTIME=browser npx next build && NEXT_PUBLIC_CLEARING_RUNTIME=browser npx next start --port 3100
 *
 * The default playwright config's webServer probe expects /api/status to answer 2xx, so point a
 * config without `webServer` (or CLEARING_BASE_URL with an already running server) at this spec.
 */
test.describe.configure({ mode: "serial" });

const BADGE = "Demo suppliers · Local rules · Simulated orders · Browser runtime";

async function uiPhase(page: Page, phase: Phase, timeout = 30_000) {
  await expect(phaseChip(page, phase)).toBeVisible({ timeout });
}

async function snap(page: Page, name: string) {
  mkdirSync(SCRATCH, { recursive: true });
  await page.screenshot({ path: `${SCRATCH}/${name}.png`, animations: "disabled" });
}

test("browser runtime: confirm, clear, approve, cancel, recover, reload, reset — no server calls", async ({ page, request }) => {
  const probe = await request.get("/api/status");
  const body = (await probe.json().catch(() => null)) as { error?: { code?: string } } | null;
  test.skip(probe.status() !== 501 || body?.error?.code !== "server_mode_disabled", "server is not a browser-runtime build");
  test.setTimeout(120_000);

  const consoleWatch = watchConsole(page);
  const apiCalls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(`${r.method()} ${r.url()}`);
  });
  const plan = planAside(page);

  // Fresh device state.
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("clearing:runtime:v1"));
  await page.reload();

  // ---- Labels -------------------------------------------------------------------------------------
  await uiPhase(page, "confirming");
  await expect(page.getByText(BADGE, { exact: true })).toBeVisible();
  await expect(page.locator("header").getByText("On-device")).toBeVisible();
  await page.getByRole("button", { name: "Integration status" }).click();
  const popover = page.locator("#integration-status");
  await expect(popover).toContainText("Browser runtime: the whole market simulation runs in this browser; state is saved on this device only; seller policies are not kept server-side in this mode.");
  await expect(popover).toContainText("Local rules");
  await expect(popover).toContainText("350");
  await page.keyboard.press("Escape");

  // ---- Confirm → MARKET CLEARED $784.40 -------------------------------------------------------------
  await confirmButton(page).click();
  await expect(banner(page, "MARKET CLEARED")).toBeVisible({ timeout: 45_000 });
  await uiPhase(page, "proposed");
  await expect(valueOf(banner(page, "MARKET CLEARED"), "Total")).toHaveText("$784.40");
  await expect(valueOf(plan, "Total")).toHaveText("$784.40");
  await expect(selection(page, "Golden Hour Taqueria", "$565.40")).toBeVisible();
  await expect(selection(page, "Bodega Marquez", "$147.00")).toBeVisible();
  await expect(selection(page, "Pelican Couriers", "$72.00")).toBeVisible();
  await snap(page, "browser-cleared");

  // ---- Approve ---------------------------------------------------------------------------------------
  await expect(approveButton(page)).toHaveText("Approve plan r1 · $784.40");
  await approveButton(page).click();
  await uiPhase(page, "simulated_confirmed");
  await expect(ordersSection(page).getByRole("listitem")).toHaveCount(3);

  // ---- Golden Hour cancels → PLAN RECOVERED $994.14 ---------------------------------------------------
  await page.getByLabel("Supplier cancels").selectOption({ label: "Golden Hour Taqueria" });
  await disruptionsSection(page).getByRole("button", { name: "Cancel", exact: true }).click();
  const recovered = banner(page, "PLAN RECOVERED — REVIEW CHANGES");
  await expect(recovered).toBeVisible({ timeout: 45_000 });
  await uiPhase(page, "needs_approval");
  await expect(valueOf(recovered, "Total")).toHaveText("$994.14");
  await expect(valueOf(plan, "Total")).toHaveText("$994.14");
  await expect(selection(page, "Bodega Marquez", "$147.00", "Kept")).toBeVisible();
  await expect(orderRow(page, "Golden Hour Taqueria")).toContainText("Cancelled");
  await snap(page, "browser-recovered");

  // ---- Reload: state persists on this device ----------------------------------------------------------
  const eventsBefore = await historyTotal(page);
  await page.reload();
  await uiPhase(page, "needs_approval");
  await expect(banner(page, "PLAN RECOVERED — REVIEW CHANGES")).toBeVisible();
  await expect(valueOf(plan, "Total")).toHaveText("$994.14");
  await expect(approveButton(page)).toHaveText("Approve plan r2 · $994.14");
  await expect.poll(() => historyTotal(page), { message: "history restored from this device after reload" }).toBe(eventsBefore);

  // ---- Reset ---------------------------------------------------------------------------------------------
  await page.locator("header").getByRole("button", { name: "Reset", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reset the demo?" });
  await dialog.getByRole("button", { name: "Reset run" }).click();
  await uiPhase(page, "confirming");
  await expect(banner(page, /PLAN RECOVERED|MARKET CLEARED/)).toHaveCount(0);
  await expect.poll(() => historyTotal(page)).toBeLessThan(eventsBefore);
  await page.reload();
  await uiPhase(page, "confirming");

  expect(apiCalls, "the browser runtime makes no API calls").toEqual([]);
  consoleWatch.expectClean();
});

test("browser runtime: server-only pages say so", async ({ page, request }) => {
  const probe = await request.get("/api/status");
  test.skip(probe.status() !== 501, "server is not a browser-runtime build");
  await page.goto("/agent");
  await expect(page.getByText("Needs the server mode")).toBeVisible();
  await page.goto(`/attend/${"a".repeat(48)}`);
  await expect(page.getByText("Needs the server mode")).toBeVisible();
  const res = await request.post("/api/reset");
  expect(res.status()).toBe(501);
  expect((await res.json()).error.code).toBe("server_mode_disabled");
});

test("browser runtime: a refresh mid-pipeline re-arms the job and the market still clears", async ({ page, request }) => {
  const probe = await request.get("/api/status");
  test.skip(probe.status() !== 501, "server is not a browser-runtime build");
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("clearing:runtime:v1"));
  await page.reload();
  await uiPhase(page, "confirming");
  await confirmButton(page).click();
  await expect(phaseChip(page, "collecting")).toBeVisible();
  await page.reload(); // the job is unfinished in localStorage; the runtime re-arms it on load
  await expect(banner(page, "MARKET CLEARED")).toBeVisible({ timeout: 45_000 });
  await expect(valueOf(planAside(page), "Total")).toHaveText("$784.40");
  await page.locator("header").getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("dialog", { name: "Reset the demo?" }).getByRole("button", { name: "Reset run" }).click();
  await uiPhase(page, "confirming");
});
