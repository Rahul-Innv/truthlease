import { expect, test } from "@playwright/test";
import {
  approveButton,
  banner,
  briefAside,
  confirmButton,
  historyRegion,
  node,
  orderRow,
  ordersSection,
  planAside,
  requestBox,
  resetViaApi,
  getRun,
  shot,
  valueOf,
  waitForPhase,
  watchConsole,
} from "./helpers";

/**
 * Edge behaviour, run in both the desktop (1440x900) and mobile (390x844) projects:
 * an impossible budget, keyboard-only operation, and the 390 px layout. Every test also asserts
 * that the browser logged no console error, warning or page error.
 */

test("impossible budget: an honest no-feasible-plan with the exact gap, and nothing to approve", async ({ page, request }) => {
  const consoleWatch = watchConsole(page);
  await resetViaApi(request);
  await page.goto("/");
  await waitForPhase(page, "confirming");

  // Replace "$1,000" with "$500" in the request and re-interpret it.
  const box = requestBox(page);
  const text = await box.inputValue();
  expect(text).toContain("$1,000");
  await box.fill(text.replace("$1,000", "$500"));
  await page.getByRole("button", { name: "Re-interpret request" }).click();
  await expect(briefAside(page).getByText("$500.00")).toBeVisible();
  await expect(page.getByText("request v2")).toBeVisible();
  await expect(confirmButton(page)).toBeEnabled();

  await confirmButton(page).click();
  await expect(banner(page, "NO FEASIBLE PLAN")).toBeVisible({ timeout: 45_000 });
  await waitForPhase(page, "no_feasible_plan");

  // The gap is the cheapest otherwise-valid package ($784.40) minus the $500 budget.
  const infeasible = banner(page, "NO FEASIBLE PLAN");
  await expect(valueOf(infeasible, "Budget gap")).toHaveText("$284.40");
  await expect(valueOf(infeasible, "Closest package")).toHaveText("$784.40");
  await expect(infeasible).toContainText("Nothing was relaxed automatically");
  const card = page.locator("section[aria-labelledby='infeasible-title']:visible");
  if (await card.count()) {
    // Desktop layout: the plan panel carries the full card.
    await expect(card).toContainText("Bodega Marquez + Golden Hour Taqueria + Pelican Couriers");
    await expect(valueOf(card, "Gap")).toHaveText("$284.40");
    await expect(valueOf(card, "Budget")).toHaveText("$500.00");
  }
  // On every layout the raise-budget action names the closest package.
  await expect(page.getByRole("button", { name: "Raise budget to $784.40" })).toBeVisible();

  // Approve is absent, or disabled with a reason: never an enabled button.
  const approve = approveButton(page);
  if ((await approve.count()) > 0) {
    await expect(approve).toBeDisabled();
    await expect(page.getByText("No feasible plan to approve.")).toBeVisible();
  }
  // The `a` shortcut must not send an approval either, and the server holds no orders.
  const [approveRequest] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/approve"), { timeout: 1_500 }).catch(() => null),
    page.keyboard.press("a"),
  ]);
  expect(approveRequest, "pressing a with no feasible plan must not call approve").toBeNull();
  const direct = await request.post("/api/runs/current/approve", { data: { planRevision: 1, idempotencyKey: "e2e-impossible-budget-approve" } });
  expect(direct.ok(), "the server refuses to approve when there is no feasible plan").toBe(false);
  const run = await getRun(request);
  expect(run.phase).toBe("no_feasible_plan");
  expect(run.orders).toEqual([]);
  expect(run.infeasibility?.kind).toBe("over_budget");
  expect(run.infeasibility?.cheapestInvalid?.budgetGapCents).toBe(28_440);

  consoleWatch.expectClean();
});

test("keyboard: Tab to Confirm, Enter, a to approve, Enter on a node opens the drawer, Escape closes it", async ({ page, request }) => {
  test.setTimeout(120_000);
  const consoleWatch = watchConsole(page);
  await resetViaApi(request);
  await page.goto("/");
  await waitForPhase(page, "confirming");
  await expect(confirmButton(page)).toBeEnabled();

  const describeFocus = () =>
    page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e || e === document.body) return "(body)";
      return e.getAttribute("aria-label") ?? (e.innerText || e.tagName).trim().slice(0, 40);
    });

  // From the top of the page, Tab reaches the Confirm button without the mouse.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const visited: string[] = [];
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press("Tab");
    visited.push(await describeFocus());
    reached = await confirmButton(page).evaluate((el) => el === document.activeElement);
  }
  expect(reached, `Tab never reached "Confirm & open market"; focus visited: ${visited.join(" > ")}`).toBe(true);
  await expect(confirmButton(page)).toBeFocused();

  // Enter opens the market; it clears.
  await page.keyboard.press("Enter");
  await expect(banner(page, "MARKET CLEARED")).toBeVisible({ timeout: 45_000 });
  await waitForPhase(page, "proposed");
  await expect(approveButton(page)).toBeEnabled();

  // `a` approves the proposed plan; the orders appear as simulated-confirmed.
  await page.keyboard.press("a");
  await waitForPhase(page, "simulated_confirmed");
  await expect(ordersSection(page).getByRole("listitem")).toHaveCount(3);
  for (const merchant of ["Golden Hour Taqueria", "Bodega Marquez", "Pelican Couriers"]) {
    await expect(orderRow(page, merchant)).toContainText("Simulated · confirmed");
  }
  await expect(approveButton(page)).toBeDisabled();

  // Tab onto a market node (they are real buttons with accessible names).
  const nodeButtons = page.locator("button[data-merchant]");
  await expect(nodeButtons).toHaveCount(7);
  let onNode = false;
  const visitedAfter: string[] = [];
  for (let i = 0; i < 60 && !onNode; i++) {
    await page.keyboard.press("Tab");
    visitedAfter.push(await describeFocus());
    onNode = await page.evaluate(() => Boolean((document.activeElement as HTMLElement | null)?.matches("button[data-merchant]")));
  }
  expect(onNode, `Tab never reached a market node; focus visited: ${visitedAfter.join(" > ")}`).toBe(true);
  const focusedNode = page.locator("button[data-merchant]:focus");
  await expect(focusedNode).toHaveCount(1);
  const label = (await focusedNode.getAttribute("aria-label")) ?? "";
  const merchantName = label.split(". ")[0]!;
  expect(merchantName.length).toBeGreaterThan(3);

  // Enter opens that supplier's drawer; Escape closes it and focus returns to the node.
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: merchantName });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close offer details" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.locator("button[data-merchant]:focus")).toHaveAttribute("aria-label", label);

  consoleWatch.expectClean();
});

test("mobile layout: no horizontal scroll, sticky approve bar, readable plan total", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "390 px layout is checked in the mobile project only");
  test.setTimeout(120_000);
  const consoleWatch = watchConsole(page);
  await resetViaApi(request);
  await page.goto("/");
  await waitForPhase(page, "confirming");

  // The page is usable at 390 px before the market opens, too.
  const noSideScroll = () =>
    page.evaluate(() => {
      const el = document.scrollingElement!;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, innerWidth: window.innerWidth };
    });
  const beforeConfirm = await noSideScroll();
  expect(beforeConfirm.scrollWidth, JSON.stringify(beforeConfirm)).toBeLessThanOrEqual(beforeConfirm.clientWidth);

  await confirmButton(page).click();
  await expect(banner(page, "MARKET CLEARED")).toBeVisible({ timeout: 45_000 });
  await waitForPhase(page, "proposed");
  await expect(approveButton(page)).toBeEnabled();

  // 1. No horizontal page scroll once the full plan, graph and history are on screen.
  const metrics = await noSideScroll();
  expect(metrics.innerWidth).toBe(390);
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);

  // 2. The sticky approve bar is visible at the top of the page and stays pinned at the bottom of it.
  const approve = approveButton(page);
  await expect(approve).toHaveCount(1); // the plan panel's own button is hidden below `lg`
  await expect(approve).toBeVisible();
  await expect(approve).toHaveText("Approve plan r1 · $784.40");
  await expect(approve).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(approve).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(approve).toBeInViewport({ ratio: 1 });
  const box = (await approve.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThanOrEqual(36); // a thumb-sized target

  // 3. The plan total in the bar is readable: on screen, not clipped, at least 12 px.
  const barLabel = page.getByText("Plan r1", { exact: true });
  await expect(barLabel).toBeVisible();
  const barTotal = barLabel.locator("xpath=..").getByText("$784.40", { exact: true });
  await expect(barTotal).toBeVisible();
  await expect(barTotal).toBeInViewport({ ratio: 1 });
  const readable = await barTotal.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { fontSize: parseFloat(cs.fontSize), clipped: el.scrollWidth > el.clientWidth, left: r.left, right: r.right };
  });
  expect(readable.fontSize, JSON.stringify(readable)).toBeGreaterThanOrEqual(12);
  expect(readable.clipped, JSON.stringify(readable)).toBe(false);
  expect(readable.left).toBeGreaterThanOrEqual(0);
  expect(readable.right).toBeLessThanOrEqual(390);
  // The banner and the plan panel carry the same total, fully on screen.
  await expect(valueOf(banner(page, "MARKET CLEARED"), "Total")).toHaveText("$784.40");
  await expect(valueOf(planAside(page), "Total")).toHaveText("$784.40");

  // The sticky bar never hides the last thing on the page.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const history = (await historyRegion(page).boundingBox())!;
  const bar = (await barLabel.boundingBox())!;
  expect(history.y + history.height, "history must end above the sticky bar").toBeLessThanOrEqual(bar.y + 1);
  await page.evaluate(() => window.scrollTo(0, 0));

  // The market nodes are reachable and the page still does not scroll sideways with the drawer open.
  await node(page, "Juniper & Rye Catering", "Rejected").scrollIntoViewIfNeeded();
  await shot(page, "mobile-cleared");
  const afterAll = await noSideScroll();
  expect(afterAll.scrollWidth, JSON.stringify(afterAll)).toBeLessThanOrEqual(afterAll.clientWidth);

  consoleWatch.expectClean();
});
