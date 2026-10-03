import { expect, test } from "@playwright/test";
import {
  PRESET_REQUEST_TEXT,
  approveButton,
  banner,
  briefAside,
  confirmButton,
  disruptionsSection,
  dollarsToCents,
  getRun,
  historyCount,
  historyTotal,
  node,
  orderRow,
  ordersSection,
  phaseChip,
  planAside,
  requestBox,
  selection,
  shot,
  valueOf,
  waitForPhase,
  waitForServerPhase,
  watchConsole,
} from "./helpers";

/**
 * The organizer journey, driven only through the real UI (the API is used for the initial reset
 * and for cross-checks, never to move the run forward):
 *   preset -> confirm -> MARKET CLEARED -> inspect a rejected offer -> approve
 *   -> supplier cancels -> PLAN RECOVERED -> approve -> refresh -> headcount 85 -> NO FEASIBLE PLAN
 *   -> raise budget -> PLAN RECOVERED -> reset.
 * Numbers are the ones DEMO_SCRIPT.md and docs/LLD.md section 9 compute from the fictional catalog.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  const res = await request.post("/api/reset");
  expect(res.ok()).toBe(true);
});

test("organizer journey: request, clear, approve, recover, refresh, infeasible, recover, reset", async ({ page, request }) => {
  test.setTimeout(120_000);
  const consoleWatch = watchConsole(page);
  const plan = planAside(page);

  // ---- 1. Preset request, confirming, nothing missing ----------------------------------------
  await page.goto("/");
  await waitForPhase(page, "confirming");
  await expect(phaseChip(page)).toHaveText("Confirm requirements", { useInnerText: true });
  await expect(page.getByText("Demo suppliers · Local rules · Simulated orders")).toBeVisible();
  await expect(requestBox(page)).toHaveValue(PRESET_REQUEST_TEXT);
  const brief = briefAside(page);
  await expect(brief.getByText("60 guests")).toBeVisible();
  await expect(brief.getByText("20 vegetarian")).toBeVisible();
  await expect(brief.getByText("6:30 PM", { exact: true }).first()).toBeVisible();
  await expect(brief.getByText("$1,000.00")).toBeVisible();
  await expect(brief.getByText("Missing", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/\d+ missing/)).toHaveCount(0);
  await expect(confirmButton(page)).toBeEnabled();
  await expect(page.getByText("Suppliers in the demo catalog will quote against these requirements.")).toBeVisible();

  // ---- 2. Confirm: the market opens and clears -----------------------------------------------
  await confirmButton(page).click();
  await expect(banner(page, "MARKET CLEARED")).toBeVisible({ timeout: 45_000 });
  await waitForPhase(page, "proposed");
  await expect(phaseChip(page)).toHaveText("Plan proposed", { useInnerText: true });

  const cleared = banner(page, "MARKET CLEARED");
  await expect(cleared).toContainText("r1 awaits approval");
  await expect(valueOf(cleared, "Total")).toHaveText("$784.40");
  await expect(valueOf(cleared, "Remaining")).toHaveText("$215.60");
  await expect(valueOf(cleared, "Slack")).toHaveText("20 min");
  await expect(valueOf(plan, "Total")).toHaveText("$784.40");
  await expect(valueOf(plan, "Remaining")).toHaveText("$215.60");
  await expect(valueOf(plan, "Slack")).toHaveText("20 min");

  // Exactly the three documented suppliers are selected, with their prices.
  await expect(plan.getByRole("button", { name: /Open offer details\.$/ })).toHaveCount(3);
  await expect(selection(page, "Golden Hour Taqueria", "$565.40")).toBeVisible();
  await expect(selection(page, "Bodega Marquez", "$147.00")).toBeVisible();
  await expect(selection(page, "Pelican Couriers", "$72.00")).toBeVisible();
  await expect(node(page, "Golden Hour Taqueria", "Selected")).toBeVisible();
  await expect(node(page, "Bodega Marquez", "Selected")).toBeVisible();
  await expect(node(page, "Pelican Couriers", "Selected")).toBeVisible();
  await expect(valueOf(page.getByRole("region", { name: "Market" }), "Candidates checked")).toHaveText("41");
  await shot(page, "cleared");

  // ---- 3. A rejected offer explains itself ----------------------------------------------------
  await node(page, "Juniper & Rye Catering", "Rejected").click();
  const drawer = page.getByRole("dialog", { name: "Juniper & Rye Catering" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Rejected", { exact: true })).toBeVisible();
  // Reason: a real package contains it, but the selected plan is cheaper.
  await expect(drawer).toContainText("Feasible in Juniper & Rye Catering + Bodega Marquez + Swiftline Runners ($994.14), but not chosen");
  await expect(drawer).toContainText("ranks first on lowest all-in cost, then slack");
  // Price breakdown: line items, fee, delivery and a total that adds up.
  const price = drawer.locator("section").filter({ has: page.getByRole("heading", { name: "Price" }) });
  const lineRows = price.getByRole("row");
  await expect(lineRows).toHaveCount(3); // header + 2 line items
  await expect(lineRows.first().getByRole("columnheader")).toHaveText(["Item", "Qty", "Unit", "Line"]);
  const lines = await lineRows.nth(1).locator("td").allInnerTexts();
  expect(lines).toEqual(["Roasted vegetable grain bowl (vegetarian)", "20", "$11.50", "$230.00"]);
  const lineTotal = (await price.locator("tbody td:last-child").allInnerTexts()).map(dollarsToCents).reduce((a, b) => a + b, 0);
  const fee = dollarsToCents(await valueOf(price, "Service fee (5%)").innerText());
  const delivery = dollarsToCents(await valueOf(price, "Delivery").innerText());
  const total = dollarsToCents(await valueOf(price, "Total").innerText());
  expect(total).toBe(80314);
  expect(lineTotal + fee + delivery).toBe(total);
  await drawer.getByRole("button", { name: "Close offer details" }).click();
  await expect(drawer).toBeHidden();

  // ---- 4. Approve: simulated orders ------------------------------------------------------------
  await expect(approveButton(page)).toBeEnabled();
  await expect(approveButton(page)).toHaveText("Approve plan r1 · $784.40");
  await approveButton(page).click();
  await waitForPhase(page, "simulated_confirmed");
  await expect(phaseChip(page)).toHaveText("Simulated orders confirmed", { useInnerText: true });
  await expect(banner(page, "MARKET CLEARED")).toContainText("r1 approved · simulated orders confirmed");
  await expect(ordersSection(page).getByRole("listitem")).toHaveCount(3);
  for (const merchant of ["Golden Hour Taqueria", "Bodega Marquez", "Pelican Couriers"]) {
    await expect(orderRow(page, merchant)).toContainText("Simulated · confirmed");
    await expect(orderRow(page, merchant)).toContainText("plan r1");
  }
  await expect(approveButton(page)).toBeDisabled();
  await shot(page, "approved");

  // ---- 5. Disruption: Golden Hour cancels -------------------------------------------------------
  await page.getByLabel("Supplier cancels").selectOption({ label: "Golden Hour Taqueria" });
  await disruptionsSection(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(banner(page, "PLAN RECOVERED — REVIEW CHANGES")).toBeVisible({ timeout: 45_000 });
  await waitForPhase(page, "needs_approval");
  await expect(phaseChip(page)).toHaveText("Repaired · needs approval", { useInnerText: true });

  const recovered = banner(page, "PLAN RECOVERED — REVIEW CHANGES");
  await expect(recovered).toContainText("r2 needs approval");
  await expect(valueOf(recovered, "Total")).toHaveText("$994.14");
  await expect(valueOf(plan, "Total")).toHaveText("$994.14");
  await expect(selection(page, "Bodega Marquez", "$147.00", "Kept")).toBeVisible();
  await expect(selection(page, "Juniper & Rye Catering", "$803.14", "Replaced")).toBeVisible();
  await expect(selection(page, "Swiftline Runners", "$44.00", "Replaced")).toBeVisible();
  // The widened explanation says why Pelican could not be kept.
  const widened = plan.locator("p").filter({ hasText: "Widened repair" });
  await expect(widened).toContainText("Keeping Pelican Couriers would exceed the budget by $22.14");
  await expect(widened).toContainText("Swiftline Runners replaces it");
  // Golden Hour's order is cancelled with a full, settled refund; nothing else changed yet.
  await expect(orderRow(page, "Golden Hour Taqueria")).toContainText("Cancelled");
  await expect(orderRow(page, "Golden Hour Taqueria")).toContainText("Refund $565.40 · settled");
  await expect(orderRow(page, "Bodega Marquez")).toContainText("Simulated · confirmed");
  await expect(orderRow(page, "Pelican Couriers")).toContainText("Simulated · confirmed");
  await expect(node(page, "Golden Hour Taqueria", "Withdrawn")).toBeVisible();
  await shot(page, "recovered");

  // ---- 6. Approve the repaired plan: only the changed orders move ----------------------------------
  await expect(approveButton(page)).toHaveText("Approve plan r2 · $994.14");
  await approveButton(page).click();
  await waitForPhase(page, "simulated_confirmed");
  await expect(banner(page, "PLAN RECOVERED")).toContainText("r2 approved · simulated orders confirmed");
  await expect(ordersSection(page).getByRole("listitem")).toHaveCount(5);
  await expect(orderRow(page, "Juniper & Rye Catering")).toContainText("$803.14");
  await expect(orderRow(page, "Juniper & Rye Catering")).toContainText("Simulated · confirmed");
  await expect(orderRow(page, "Juniper & Rye Catering")).toContainText("plan r2");
  await expect(orderRow(page, "Swiftline Runners")).toContainText("$44.00");
  await expect(orderRow(page, "Swiftline Runners")).toContainText("Simulated · confirmed");
  await expect(orderRow(page, "Swiftline Runners")).toContainText("plan r2");
  // Bodega's order is the original r1 order, untouched.
  await expect(orderRow(page, "Bodega Marquez")).toContainText("plan r1");
  await expect(orderRow(page, "Bodega Marquez")).toContainText("Simulated · confirmed");
  await expect(orderRow(page, "Pelican Couriers")).toContainText("Cancelled");
  await expect(orderRow(page, "Pelican Couriers")).toContainText("Dropped by approved plan r2");
  await expect(orderRow(page, "Pelican Couriers")).toContainText("Refund $72.00 · settled");
  await shot(page, "approved-r2");

  // ---- 7. Refresh: the approved plan and orders survive, nothing re-executes ------------------------
  const placedBefore = await historyCount(page, "order.simulated_placed");
  const eventsBefore = await historyTotal(page);
  const serverBefore = await getRun(request);
  expect(placedBefore).toBe(5); // 3 for r1 + 2 changed orders for r2
  expect(serverBefore.orders).toHaveLength(5);

  await page.reload();
  await waitForPhase(page, "simulated_confirmed");
  await expect(banner(page, "PLAN RECOVERED")).toContainText("r2 approved · simulated orders confirmed");
  await expect(plan.getByText("r2 · repairs r1")).toBeVisible();
  await expect(valueOf(plan, "Total")).toHaveText("$994.14");
  await expect(ordersSection(page).getByRole("listitem")).toHaveCount(5);
  await expect(orderRow(page, "Juniper & Rye Catering")).toContainText("Simulated · confirmed");
  await expect(orderRow(page, "Swiftline Runners")).toContainText("Simulated · confirmed");
  // The history is replayed from the server; wait until it is complete before counting.
  await expect.poll(() => historyTotal(page), { message: "history replays every event after reload" }).toBe(eventsBefore);
  expect(await historyCount(page, "order.simulated_placed")).toBe(placedBefore);
  expect(await historyTotal(page)).toBe(eventsBefore);
  const serverAfter = await getRun(request);
  expect(serverAfter.lastSeq).toBe(serverBefore.lastSeq);
  expect(serverAfter.orders.map((o) => `${o.id}:${o.status}`)).toEqual(serverBefore.orders.map((o) => `${o.id}:${o.status}`));
  await shot(page, "after-reload");

  // ---- 8. Headcount 60 -> 85: no feasible plan, with the exact gap ---------------------------------------
  await page.getByLabel("Headcount changes").fill("85");
  await disruptionsSection(page).getByRole("button", { name: "Change", exact: true }).click();
  await expect(banner(page, "NO FEASIBLE PLAN")).toBeVisible({ timeout: 45_000 });
  await waitForPhase(page, "no_feasible_plan");
  const infeasible = banner(page, "NO FEASIBLE PLAN");
  await expect(valueOf(infeasible, "Budget gap")).toHaveText("$143.57");
  await expect(valueOf(infeasible, "Closest package")).toHaveText("$1,143.57");
  await expect(infeasible).toContainText("Nothing was relaxed automatically");
  const card = plan.locator("section[aria-labelledby='infeasible-title']");
  await expect(card).toContainText("Closest otherwise-valid package");
  await expect(card).toContainText("Bodega Marquez + Harbor Kitchen Collective + Swiftline Runners");
  await expect(valueOf(card, "Exposure")).toHaveText("$1,143.57");
  await expect(valueOf(card, "Budget")).toHaveText("$1,000.00");
  await expect(valueOf(card, "Gap")).toHaveText("$143.57");
  await expect(card).toContainText("Dietary requirements are never relaxed automatically");
  // Nothing to approve, and the existing simulated orders are unchanged.
  await expect(approveButton(page)).toHaveCount(0);
  await expect(ordersSection(page).getByRole("listitem")).toHaveCount(5);
  await shot(page, "infeasible");

  // ---- 9. Raise the budget to the closest package -----------------------------------------------------------
  await page.getByRole("button", { name: "Raise budget to $1,143.57" }).click();
  await expect(banner(page, /^PLAN RECOVERED/)).toBeVisible({ timeout: 45_000 });
  await waitForPhase(page, "needs_approval");
  const recovered85 = banner(page, /^PLAN RECOVERED/);
  await expect(valueOf(recovered85, "Total")).toHaveText("$1,143.57");
  await expect(valueOf(recovered85, "Remaining")).toHaveText("$0.00");
  await expect(valueOf(plan, "Total")).toHaveText("$1,143.57");
  await expect(valueOf(plan, "Budget")).toHaveText("$1,143.57");
  await expect(selection(page, "Harbor Kitchen Collective", "$891.32")).toBeVisible();
  await expect(node(page, "Harbor Kitchen Collective", "Replacement")).toBeVisible();
  await expect(selection(page, "Swiftline Runners", "$44.00", "Kept")).toBeVisible();
  await expect(selection(page, "Bodega Marquez", "$208.25", "Re-quoted")).toBeVisible();
  await expect(approveButton(page)).toHaveText("Approve plan r3 · $1,143.57");
  await shot(page, "recovered-85");

  // ---- 10. Reset: the preset is back ---------------------------------------------------------------------------
  await page.locator("header").getByRole("button", { name: "Reset", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reset the demo?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Reset run" }).click();
  await expect(dialog).toBeHidden();
  await waitForPhase(page, "confirming");
  await expect(requestBox(page)).toHaveValue(PRESET_REQUEST_TEXT);
  await expect(confirmButton(page)).toBeEnabled();
  await expect(ordersSection(page)).toContainText("No simulated orders yet");
  await expect(banner(page, /MARKET CLEARED|PLAN RECOVERED|NO FEASIBLE PLAN/)).toHaveCount(0);
  const reset = await waitForServerPhase(request, "confirming");
  expect(reset.orders).toEqual([]);
  expect(reset.requirements?.budgetCents).toBe(100_000);
  expect(reset.requirements?.headcount).toBe(60);
  await shot(page, "reset");

  consoleWatch.expectClean();
});
