import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Shared helpers for the browser specs.
 *
 * Selector policy: role and accessible name first, then the visible text the app itself uses.
 * Nothing here reads component internals, and no helper weakens an assertion: the phase waits
 * only change what happens when a wait *fails* (they say whether the server or the UI is at fault).
 */

export const SCRATCH = "/tmp/claude-0/-home-user-truthlease/3b72e7ba-b5da-56cf-a9b0-0dbee746494c/scratchpad";

export const PRESET_REQUEST_TEXT =
  "Dinner for 60 hackathon attendees at our already-booked venue. At least 20 need vegetarian meals; the rest are flexible. Include nonalcoholic drinks, plates, and utensils. Everything ready by 6:30 PM. Maximum $1,000 including all fees and delivery.";

export type Phase =
  | "draft"
  | "confirming"
  | "collecting"
  | "negotiating"
  | "clearing"
  | "proposed"
  | "approved"
  | "simulated_confirmed"
  | "disrupted"
  | "repairing"
  | "needs_approval"
  | "no_feasible_plan";

export interface RunSnapshot {
  id: string;
  phase: Phase;
  requestVersion: number;
  currentPlanRevision: number | null;
  lastSeq: number;
  budgetCents?: number;
  orders: { id: string; merchantName: string; status: string; planRevision: number }[];
  plans: { revision: number; status: string; totals: { totalCents: number } }[];
  requirements: { missing: string[]; budgetCents: number; headcount: number } | null;
  infeasibility: { kind: string; cheapestInvalid?: { totalCents: number; budgetGapCents: number; merchants: string[] } } | null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function getRun(request: APIRequestContext): Promise<RunSnapshot> {
  const res = await request.get("/api/runs/current");
  expect(res.ok(), "GET /api/runs/current").toBe(true);
  return (await res.json()).run as RunSnapshot;
}

/** POST /api/reset and check the preset came back in `confirming` with nothing missing. */
export async function resetViaApi(request: APIRequestContext): Promise<RunSnapshot> {
  const res = await request.post("/api/reset");
  expect(res.ok(), "POST /api/reset").toBe(true);
  const run = (await res.json()).run as RunSnapshot;
  expect(run.phase).toBe("confirming");
  expect(run.requirements?.missing).toEqual([]);
  return run;
}

/** Poll GET /api/runs/current until the server run reaches one of the phases. Server truth, no UI involved. */
export async function waitForServerPhase(request: APIRequestContext, phases: Phase | Phase[], timeout = 30_000): Promise<RunSnapshot> {
  const wanted = Array.isArray(phases) ? phases : [phases];
  await expect
    .poll(async () => (await getRun(request)).phase, { timeout, intervals: [150, 250, 500], message: `server phase to become ${wanted.join(" | ")}` })
    .toMatch(new RegExp(`^(${wanted.join("|")})$`));
  return getRun(request);
}

// ---------------------------------------------------------------------------
// Phase chip, banners, panels
// ---------------------------------------------------------------------------

/** The top-bar phase chip; its `title` is `Phase: <phase>`. */
export function phaseChip(page: Page, phase?: Phase): Locator {
  const header = page.locator("header");
  return phase ? header.getByTitle(`Phase: ${phase}`, { exact: true }) : header.getByTitle(/^Phase: /);
}

/**
 * Wait for the UI phase chip. If the UI never gets there the error says whether the server did:
 * "server is at X, UI shows Y" separates a stalled pipeline from a stream that did not reach the page.
 */
export async function waitForPhase(page: Page, phase: Phase, timeout = 30_000): Promise<void> {
  try {
    await expect(phaseChip(page, phase)).toBeVisible({ timeout });
  } catch (cause) {
    const server = await getRun(page.request).then((r) => r.phase).catch(() => "unreachable");
    const ui = await phaseChip(page).first().getAttribute("title", { timeout: 1_000 }).catch(() => "no chip");
    const verdict = server === phase ? "the server reached it, so the snapshot/stream did not reach the UI" : "the server did not reach it either";
    throw new Error(`Phase "${phase}" not shown within ${timeout} ms: server phase "${server}", UI chip "${ui}" (${verdict}).`, { cause });
  }
}

export type BannerTitle = "MARKET CLEARED" | "PLAN RECOVERED — REVIEW CHANGES" | "PLAN RECOVERED" | "NO FEASIBLE PLAN";

/** The signature banner. History rows echo the same words, so match inside role=status only. */
export function banner(page: Page, title: BannerTitle | RegExp): Locator {
  return page.getByRole("status").filter({ has: page.getByText(title, { exact: typeof title === "string" }) });
}

export const planAside = (page: Page): Locator => page.getByRole("complementary", { name: "Plan and approval" });
export const briefAside = (page: Page): Locator => page.getByRole("complementary", { name: "Brief and requirements" });
export const historyRegion = (page: Page): Locator => page.getByRole("region", { name: "History" });

/** The `<dd>` that follows the `<dt>` with exactly this label, inside `scope`. */
export function valueOf(scope: Locator, label: string): Locator {
  const exact = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  return scope.getByRole("term").filter({ hasText: exact }).locator("xpath=following-sibling::dd[1]");
}

export const confirmButton = (page: Page): Locator => page.getByRole("button", { name: "Confirm & open market" });
/** Only the visible Approve button matches: the plan panel has one on desktop, the sticky bar one below `lg`. */
export const approveButton = (page: Page): Locator => page.getByRole("button", { name: /^Approve plan/ });
export const requestBox = (page: Page): Locator => page.getByLabel("What does the event need?");

/** A selection row in the plan panel, e.g. `selection(page, "Bodega Marquez", "$147.00", "Kept")`. */
export function selection(page: Page, merchant: string, total: string, change?: string): Locator {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return planAside(page).getByRole("button", { name: new RegExp(`^${esc(merchant)}, ${esc(total)}${change ? `, ${esc(change)}` : ""}\\.`) });
}

/** A market node, by supplier name and state word, e.g. `node(page, "Juniper & Rye Catering", "Rejected")`. */
export function node(page: Page, merchant: string, state: string): Locator {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${esc(merchant)}\\. ${esc(state)}[.,]`) });
}

export function ordersSection(page: Page): Locator {
  return planAside(page).locator("section").filter({ has: page.getByRole("heading", { name: "Simulated orders" }) });
}

export const orderRow = (page: Page, merchant: string): Locator => ordersSection(page).getByRole("listitem").filter({ hasText: merchant });

export function disruptionsSection(page: Page): Locator {
  return planAside(page).locator("section").filter({ has: page.getByRole("heading", { name: "Disruptions" }) });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Total event count from the history header ("50 events · newest first"). */
export async function historyTotal(page: Page): Promise<number> {
  const label = historyRegion(page).getByText(/^\d+ events? · newest first$/);
  await expect(label).toBeVisible();
  return Number((await label.innerText()).match(/^(\d+)/)![1]);
}

/**
 * Number of history rows of one event type. The panel shows only the newest 40 rows until
 * "Show all N events" is pressed, so expand it first when it is offered.
 */
export async function historyCount(page: Page, type: string): Promise<number> {
  const showAll = historyRegion(page).getByRole("button", { name: /^Show all \d+ events$/ });
  if (await showAll.count()) await showAll.click();
  return historyRegion(page).getByTitle(type, { exact: true }).count();
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export interface ConsoleWatch {
  readonly problems: string[];
  /** Assert that nothing at all was logged as an error or warning, and no page error was thrown. */
  expectClean(): void;
}

/** Collect every console error/warning and uncaught page error. Nothing is allow-listed. */
export function watchConsole(page: Page): ConsoleWatch {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`console.${m.type()}: ${m.text()} @ ${m.location().url}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return {
    problems,
    expectClean() {
      expect(problems, "console errors, warnings and page errors").toEqual([]);
    },
  };
}

// ---------------------------------------------------------------------------
// Money and screenshots
// ---------------------------------------------------------------------------

export function dollarsToCents(text: string): number {
  const m = text.replace(/,/g, "").match(/-?\$(\d+)\.(\d{2})/);
  if (!m) throw new Error(`No dollar amount in "${text}"`);
  return Number(m[1]) * 100 + Number(m[2]);
}

/** Viewport screenshot at a signature moment, written to the scratchpad as e2e-<name>.png. */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SCRATCH, { recursive: true });
  await page.screenshot({ path: `${SCRATCH}/e2e-${name}.png`, animations: "disabled" });
}
