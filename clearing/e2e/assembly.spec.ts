/**
 * P1 supply assembly through the real UI: 130 attendees cannot be served by any single
 * demo kitchen, so the market assembles two kitchens plus a courier into one package.
 */
import { expect, test } from "@playwright/test";
import {
  banner,
  briefAside,
  confirmButton,
  planAside,
  requestBox,
  resetViaApi,
  selection,
  shot,
  valueOf,
  waitForPhase,
  watchConsole,
} from "./helpers";

test("supply assembly: two kitchens plus delivery clear a 130-attendee request", async ({ page, request }) => {
  const consoleWatch = watchConsole(page);
  await resetViaApi(request);
  await page.goto("/");
  await waitForPhase(page, "confirming");

  const box = requestBox(page);
  const text = await box.inputValue();
  await box.fill(text.replace("60 hackathon attendees", "130 hackathon attendees").replace("$1,000", "$2,600"));
  await page.getByRole("button", { name: "Re-interpret request" }).click();
  await expect(briefAside(page).getByText("130 guests")).toBeVisible();
  await expect(briefAside(page).getByText("$2,600.00")).toBeVisible();
  await expect(confirmButton(page)).toBeEnabled();

  await confirmButton(page).click();
  await expect(banner(page, "MARKET CLEARED")).toBeVisible({ timeout: 60_000 });
  await waitForPhase(page, "proposed");

  const cleared = banner(page, "MARKET CLEARED");
  await expect(valueOf(cleared, "Total")).toHaveText("$1,858.02");

  // Two kitchens in one package, each with its own cost, plus the courier Golden Hour needs.
  await expect(selection(page, "Harbor Kitchen Collective", "$1,262.52")).toBeVisible();
  await expect(selection(page, "Golden Hour Taqueria", "$205.00")).toBeVisible();
  await expect(selection(page, "Bodega Marquez", "$318.50")).toBeVisible();
  await expect(selection(page, "Pelican Couriers", "$72.00")).toBeVisible();
  await expect(planAside(page).getByText("4 suppliers")).toBeVisible();

  // Coverage: 130 meals including 20 vegetarian are supplied across the two kitchens.
  const coverage = planAside(page).locator("table").first();
  await expect(coverage).toContainText("20");
  await expect(coverage).toContainText("130");

  await shot(page, "assembled");
  consoleWatch.expectClean();
});
