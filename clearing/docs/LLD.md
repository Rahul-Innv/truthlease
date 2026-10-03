# Clearing — Low-Level Design

Companion to `HLD.md`. This is the build spec workers implement against. Where this
document and `src/lib/contracts.ts` disagree, the contracts file wins and this document
is updated.

---

## 1. Module map and dependency direction

```
src/lib/contracts.ts        ← everything depends on this; nobody else defines shapes
src/lib/time.ts, money.ts   ← pure helpers
src/lib/catalog.ts          ← Merchant (private) + MerchantPublic; depends on contracts
src/lib/interpret.ts        ← RequestInput → Requirements; depends on catalog (venue), time, money
src/lib/ledger.ts           ← exposure math; depends on contracts, money
src/lib/solver.ts           ← Demand, validateCandidate, solve, buildPlan, explainInfeasibility; depends on ledger, time
src/lib/seller.ts           ← quote, respond, delayOffer; depends on solver (Demand), money, time
src/lib/buyer.ts            ← planRound; depends on solver
src/lib/providers/*.ts      ← reasoning interface, local + live adapters, integration status  [TO BUILD]
src/lib/store.ts            ← SQLite; depends on contracts                                      [TO BUILD]
src/lib/service.ts          ← commands + pipeline; depends on all of the above                 [TO BUILD]
src/app/api/**              ← route handlers; depend on service + contracts                    [TO BUILD]
src/app/**, src/components  ← UI; depends on contracts (types) and the HTTP API only            [TO BUILD]
tests/**                    ← Vitest; depends on lib + service (in-memory SQLite)               [TO BUILD]
e2e/**                      ← Playwright; depends on the running app                           [TO BUILD]
```

Status: modules marked ← without a tag exist and typecheck. `scripts/simulate.ts` is a
design-time diagnostic that runs the pure modules end to end (output in §9).

## 2. Data model

### 2.1 Run (authoritative state, one JSON blob per run)

`Run` in contracts. Key fields and their meaning:

| Field | Meaning |
|---|---|
| `version` | Optimistic lock for the row; every write does `WHERE version = ?` |
| `requestVersion` | Bumps on submit, confirm-with-edits, budget change, headcount disruption |
| `phase` | See HLD §6 |
| `request` | Raw organizer input (text, eventDate, timezone, nowLocal, venueName?) |
| `requirements` | Interpreted requirements with `fieldStatus`, `assumptions`, `missing` |
| `merchants` | Public snapshot of the catalog at run creation (policy stripped) |
| `availability` | Per-merchant `{available, reason}`; cancellations flip this |
| `offers` | Every offer revision ever created in the run; latest open per id is selectable |
| `negotiation` | Request/outcome log, one row per lever ask |
| `plans` | Every plan revision; `status` proposed/approved/superseded/infeasible |
| `currentPlanRevision` | The revision the UI shows as current |
| `approvals`, `orders`, `ledger` | Simulated money trail |
| `disruptions` | Typed injections with timestamps |
| `infeasibility` | Set when the latest clearing/repair found no feasible plan |
| `job` | In-flight pipeline marker `{id, kind, requestVersion, startedAt}` or null |
| `lastSeq` | Last event sequence number written for this run |
| `modelCalls`, `lastError` | Diagnostics |

### 2.2 Identity and revisions

- Offer id: `off_<merchantSlug>_v<requestVersion>`; revisions 1..n; a revision supersedes the previous (`status: superseded`). Withdrawn offers (`withdrawn`) and expired ones (`expired`, computed at validation) are never selectable.
- Plan revision: run-scoped integer, monotonic. Proposing a new plan marks the previous current plan `superseded` unless it is `approved` (an approved plan stays approved until a new revision is approved; the UI shows before/after).
- Order id: `ord_<planRevision>_<merchantSlug>`.
- Event id: `evt_<runId>_<seq>`.
- Idempotency key: client-generated (UUID), stored with the serialized response.

### 2.3 SQLite schema

```sql
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL              -- Run JSON, validated on read and write
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  cause_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,           -- JSON
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS idempotency (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  response TEXT NOT NULL,          -- JSON {status, body}
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);  -- current_run_id
```

Store API (`src/lib/store.ts`):

```ts
openStore(path | ":memory:"): Store
store.getRun(id): Run | null
store.getCurrentRunId(): string | null
store.setCurrentRunId(id)
store.listEvents(runId, afterSeq, limit): RunEvent[]
store.getIdempotent(runId, key): {status, body} | null
/** Atomic: CAS on version, append events (assigning seq), persist idempotent response. Throws VersionConflict. */
store.commit(tx: { run: Run, expectedVersion: number, events: NewEvent[], idempotent?: {key, status, body} }): Run
store.insertRun(run)
store.deleteAll()  // reset
```

Implementation: `const { DatabaseSync } = process.getBuiltinModule("node:sqlite")` to keep
the bundler out of it. One `Store` per process, cached on `globalThis` to survive HMR.

## 3. Service layer (`src/lib/service.ts`)

All commands take `(store, clock, providers)` via a `ServiceDeps` object for testability.
`clock.now()` returns ISO; tests inject a fixed clock.

| Command | Preconditions | State change | Events |
|---|---|---|---|
| `createPresetRun()` | — | New run in `draft` with the editable preset; merchants snapshot | `run.created` |
| `submitRequest(runId, RequestInput)` | phase ∈ {draft, confirming, proposed, no_feasible_plan, simulated_confirmed…} (any non-busy phase) | `request` set, `requestVersion++`, `requirements` = interpret(), phase `confirming`, prior plans superseded, offers cleared only if quantities/zone changed | `request.submitted`, `requirements.extracted` |
| `confirmRequirements(runId, {edits?})` | phase `confirming`, `missing` empty after edits | phase `collecting`, job `collect` started | `requirements.confirmed`, `market.opened` |
| `advance(runId)` | job present | Runs the next pipeline step (see §4); safe to call repeatedly | pipeline events |
| `approve(runId, {planRevision, idempotencyKey})` | phase ∈ {proposed, needs_approval}; plan.revision == currentPlanRevision; revalidation passes | plan `approved`; orders placed (changed selections only); charges; phase `approved` → `simulated_confirmed` | `plan.approved`, `order.simulated_placed`×n, `order.simulated_confirmed`×n |
| `disrupt(runId, {disruption, idempotencyKey})` | phase ∈ {simulated_confirmed, proposed, needs_approval, no_feasible_plan} | See §5; phase `disrupted` → `repairing`; job `repair` | `disruption.injected`, then per type |
| `settleRefund(runId, {orderId, idempotencyKey})` | order has pending refund | ledger `refund_pending` → `refund_settled`; exposure drops | `refund.settled` |
| `updateBudget(runId, {budgetCents, idempotencyKey})` | any non-busy phase with requirements | `requestVersion++`; if a plan exists, re-run clearing/repair with existing offers | `request.submitted`, then clearing events |
| `reset()` | — | Delete all runs/events; create preset | `run.reset`, `run.created` |

Errors are typed: `PhaseError` (409), `ValidationError` (400), `VersionConflict` (409, retry once internally), `NotFound` (404), `StaleJob` (ignored, logged as `job.failed` only if it was the active job).

### 3.1 Approval revalidation

```
plan = run.plans[revision]; require plan.status == 'proposed' && revision == currentPlanRevision
offers = exact (offerId, offerRevision) pairs from plan.selections (must exist, status open, unexpired at clock.now())
ctx = solveContext(run, previousActiveOrders)
c = validateCandidate(ctx, offers); require c.feasible  (else 409 with c.rejects)
require plan.requestVersion == run.requestVersion
```

Then, in one transaction: approval record; for each selection: if an active order exists
for the same (offerId, offerRevision) keep it; else place `simulated_placed` + ledger
`charge`; orders for merchants no longer selected are cancelled under their terms
(`order.cancelled`, `retained`/`refund_*` ledger rows). Immediately emit
`order.simulated_confirmed` for new orders (same transaction, separate events) and set
phase `simulated_confirmed`.

## 4. Pipeline (collect → negotiate → clear)

Runs as an in-process job keyed by run id. Each step reads the run, checks
`run.job.requestVersion == run.requestVersion` (else abort with `StaleJob`), does one
unit of work, commits. Pacing: `await sleep(PACE_MS)` between supplier events only.

```
step collect:
  demand = deriveDemand(run.requirements)
  for merchant in CATALOG (private) where availability.available:
    r = quote(merchant, {demand, requestVersion, nowIso, reasoning})
    emit supplier.entered {merchantId}
    if r.kind == 'offer': run.offers.push(r.offer); emit offer.received {offer}
    else: emit supplier.skipped {merchantId, reason}
  phase = negotiating; round = 1

step negotiate (round r ∈ {1,2}):
  result = solve(ctx(run))
  asks = planRound(result, demand, r, askedSet, latestOffers)         // local, or live buyer suggests levers from the same shortlist
  for ask in asks:
    emit negotiation.requested {offerId, lever, ask}
    out = respond(merchant, latestOffer, lever, r, qctx)                // local, or live seller suggests within policy; code validates
    if revised: supersede old; push new; emit offer.revised {from, to, note}
    else: emit offer.declined {offerId, reply}
  if r == 2 or asks.length == 0: phase = clearing else round++

step clear:
  emit clearing.started
  result = solve(ctx(run))                                               // previous = undefined for a fresh plan
  emit clearing.evaluated {candidatesChecked, feasibleCandidates, rejectedByReason, solverMs}
  if result.best: plan = buildPlan(...revision = next); plans.push; current = plan.revision; phase = proposed
                  emit plan.proposed {plan}; emit market.cleared {totalCents, slackMinutes}
  else: infeasibility = explainInfeasibility(...); phase = no_feasible_plan; emit plan.infeasible {infeasibility}
  job = null
```

The HTTP layer starts the job with `queueMicrotask`/`setTimeout(0)`; `GET /api/runs/current`
re-arms a job if `run.job` is set but no in-process runner exists (process restarted).

## 5. Disruptions and repair

Common: `disruption.injected` is written first (state before UI). Then:

| Type | Immediate effects | Repair inputs |
|---|---|---|
| `supplier_unavailable {merchantId}` | `availability[m] = {available:false, reason}`; all its open offers → `withdrawn` (`offer.withdrawn`); its active order → `cancelled` with terms (`order.cancelled`, `retained`/`refund_pending`/`refund_settled`) | previous = current approved/proposed plan selections; activeOrders = remaining |
| `delivery_delayed {offerId, delayMinutes}` | `delayOffer()` creates a new revision with the later arrival (`offer.requoted`); the order referencing the old revision is `superseded`-pending (kept active until the repaired plan is approved) | previous as above; the delayed revision participates like any offer |
| `headcount_changed {headcount}` | `requirements.headcount` updated, `requestVersion++`; offers whose quantities depend on headcount (meals, drinks_consumables) are re-quoted at the new quantities (`offer.requoted`, superseding); courier offers are untouched; negotiation rounds re-run on the shortlist (bounded by the same caps) | previous as above |

Repair step: `solve(ctx with previous)` ranks by **fewest changes, then lowest exposure, then
slack**. If the best feasible plan drops an unaffected selection, `changeSummary.widened`
explains why (e.g. “Keeping Pelican Couriers would exceed the budget by $22.14; Swiftline
Runners replaces it”). Outcome: phase `needs_approval` with `plan.repaired`, or
`no_feasible_plan` with `plan.infeasible` (exact gap and the cheapest otherwise-valid option).
Approving a repaired plan cancels orders for dropped selections under their terms and
places new ones; kept selections keep their orders.

Budget math used throughout (`ledger.ts`). `settleRefund` must convert the `refund_pending` ledger row into a `refund_settled` row (replace, not append), because exposure sums pending rows:

```
committed  = Σ active order amounts
retained   = Σ ledger.retained
pending    = Σ ledger.refund_pending (not yet settled)
exposure(candidate) = Σ candidate totals + retained + pending + Σ_dropped(retained_d + pending_d)
feasible iff exposure ≤ budget
```

## 6. Solver detail (`solver.ts`, implemented)

- Candidates: subsets of latest open offers, size 1–3, one offer per merchant. In the preset round 6 offers are quoted (Harbor Kitchen declines at 60) ⇒ C(6,1)+C(6,2)+C(6,3) = 41 candidates; sets that repeat a merchant are skipped before validation.
- Validation order and reject codes: `offer_not_open`, `offer_expired`, `merchant_unavailable`, `duplicate_merchant`, `service_area`, `dietary_shortfall` (veg supplied < veg need), `incomplete_coverage` (meals total < headcount, or drinks/plates/utensils short), `capacity_exceeded`, `below_min_order`, `needs_delivery` (pickup-only without courier), `delivery_unused` (courier without pickups, or two couriers), `courier_capacity`, `pickup_too_late` (ready > courier pickup-by), `arrival_too_late` (last arrival > readyBy − setup buffer), `not_fully_priced`, `over_budget`.
- Dietary: vegetarian meals may serve flexible attendees; standard meals never satisfy vegetarian need. Nobody is counted twice because both constraints are on supplied totals.
- Delivery never double-charged: `deliveryCents` sums included-delivery fees plus the courier total; a courier is only valid when at least one pickup-only offer needs it.
- Fresh ranking: total asc → slack desc → stable key. Repair ranking: changeScore asc → exposure asc → slack desc → stable key. `changeScore`: kept 0, same-merchant requote 1, new merchant 2, each removed previous merchant 1.
- Output is labelled “optimal among evaluated candidates only”.
- Contract boundary: Zod 4 enum-keyed records are exhaustive, so `buildPlan`/`explainInfeasibility` zero-fill `coverage` and `rejectedByReason`; consumers filter zeros for display.

## 7. Seller and buyer detail (implemented)

Seller (`seller.ts`): `quote()` declines outside service zone, over capacity, under minimum order, or when lead time cannot meet the default slot. Lines respect catalog min/max; service fee is a percentage of goods; included delivery adds `deliveryFeeCents`. `respond()` handles three levers: `volume_discount` (highest tier whose `minQty` ≤ primary quantity; price never below `floorPctOfList`; declines if none or already applied), `earlier_slot` (earliest permitted slot that still respects lead time; declines if `slotFlexible` is false), `later_pickup` (couriers only). Each accepted lever yields a new revision with `supersedesRevision`. `maxRounds` caps participation.

Buyer (`buyer.ts`): shortlist = top-2 feasible + top-3 near-miss candidates (near-miss = fails only on budget/timing). Levers derived from the failing constraint: arrival too late → `earlier_slot` to the late arriver; pickup too late → round 1 asks the pickup supplier for `earlier_slot`, round 2 asks the courier for `later_pickup`; price pressure → `volume_discount` on the two largest non-courier tickets. Caps: 6 asks/round, 2 rounds, never repeats an (offer, lever).

Live mode substitutes only the lever *choice* (buyer) and the response *choice* (seller) with validated model output; all caps and validation stay.

## 8. HTTP API (`src/app/api`)

All bodies validated with contracts; errors return `{error: {code, message, details?}}`.

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/runs/current` | — | `{run: Run, status: IntegrationStatus}` (creates the preset run if none) |
| `POST /api/runs/current/request` | `RequestInput` | `{run}` |
| `POST /api/runs/current/confirm` | `{edits?: Partial<{headcount, vegetarianMin, readyByLocal, budgetCents, items}>}` | `{run}` (starts collect job) |
| `POST /api/runs/current/approve` | `ApproveCommand` | `{run}` or 409 `{error, rejects}` |
| `POST /api/runs/current/disrupt` | `DisruptCommand` | `{run}` |
| `POST /api/runs/current/settle-refund` | `SettleRefundCommand` | `{run}` |
| `POST /api/runs/current/budget` | `UpdateBudgetCommand` | `{run}` |
| `POST /api/reset` | — | `{run}` |
| `GET /api/runs/current/events?after=<seq>` | SSE | `event: run.event`, `data: RunEvent` per line; `event: run.snapshot` with the full run on connect and after every command; heartbeat comment every 15 s |
| `GET /api/status` | — | `IntegrationStatus` |

Route handlers export `const dynamic = "force-dynamic"`. The SSE handler polls the store every 250 ms for `seq > lastSent` (simple, durable, no in-memory bus needed) and closes on `request.signal` abort. The in-process job runner lives on `globalThis.__clearingJobs`.

Security: no secrets in responses; request text ≤ 2,000 chars; quantities, budgets and delay minutes bounded by contracts; idempotency keys 8–80 chars; attendee pages (P1) would be separate routes with no organizer controls.

## 9. Worked example (computed by `scripts/simulate.ts` from the modules as they exist)

Preset: 60 attendees, ≥20 vegetarian, drinks + plates + utensils, ready by 6:30 PM, 20-minute setup buffer, simulated clock 2:00 PM, budget $1,000.00, fictional venue in zone `bayfront`.

| Stage | Result |
|---|---|
| Round 0 | 6 suppliers quote (Harbor Kitchen declines: min order 75). 41 candidates, **0 feasible** (timing and budget). |
| Round 1 | Golden Hour Taqueria → ready 5:00 PM, then 5% volume price ($565.40). Fogline → arrive 4:30 PM. Bodega declines (fixed prices). 3 feasible. |
| Round 2 | Juniper & Rye → 8% volume price ($803.14). 4 feasible. |
| **MARKET CLEARED** | Golden Hour $565.40 + Bodega Marquez $147.00 + Pelican Couriers $72.00 = **$784.40**, remaining $215.60, slack 20 min. |
| Cancel Golden Hour (full refund, settled) | Repair prefers fewest changes; keeping Pelican would exceed budget → widened. **PLAN RECOVERED**: Juniper & Rye $803.14 + Bodega (kept) $147.00 + Swiftline Runners $44.00 = **$994.14**, slack 10 min. Needs approval. |
| Headcount 60 → 85 | Juniper (capacity 90) re-quotes at list $1,223.88 and is not shortlisted at $1,000; Harbor now eligible ($891.32 after 6%); **NO FEASIBLE PLAN** at $1,000: cheapest otherwise-valid is Bodega + Harbor + Swiftline at $1,143.57, **gap $143.57**. |
| Organizer raises budget to $1,200 | Juniper is now shortlisted and gets its 8% ($1,129.17) but still loses. **PLAN RECOVERED**: Bodega $208.25 (re-quoted) + Harbor Kitchen $891.32 + Swiftline $44.00 (kept) = $1,143.57. |
| Delivery delayed +25 min on Swiftline (at $1,200) | Arrival 6:25 PM > 6:10 PM latest → repair evaluates Pelican/Fogline alternatives; outcome computed, not scripted. |
| Cancel every meal supplier | Blocked: `no_supply` with the reason list; no supply is invented. |

## 10. UI design

### 10.1 Reference lock (Refero)

Primary direction: **Linear-style dark three-column console** (Refero screens `58ac6637…`, `4a094449…`): narrow left brief, wide centre, narrow right panel; dense but generous line height; colored status chips with text, never color alone.
Borrowed details: **Doppler activity log** (`1d2903be…`) for the event history rows with expandable detail; **Column event-details modal** (`eb769572…`) for the evidence JSON treatment (dark panel, monospace, scroll); **Memotron graph** (`b95bc43c…`) for the restraint of the node graph (thin edges, one highlighted node state, no particles).
Explicit rejects: glow, gradients as decoration, particle systems, labels under 12 px, colour-only state.

Tokens (Tailwind 4 `@theme`): ink `#0B1220` (page), surface `#121A2B`, surface-2 `#19233A`, line `#263148`, text `#EDE8DF` (warm neutral), muted `#A3A79F`, mint `#5EEAD4` (feasible/selected), amber `#F5B451` (unresolved/needs approval), red `#F0655C` (failed/withdrawn), accent `#8EC5FF` (interactive). Type: Inter via `next/font` with `font-variant-numeric: tabular-nums` on every number; display sizes 28/20/16, body 14, meta 12 (minimum).

The UI worker should pull the four reference screens with `refero_get_screen_image` before implementing, and `refero_search_screens` for empty/error states as needed. Installing the `refero-design` skill requires the user's explicit approval and is not assumed.

### 10.2 Component tree

```
app/layout.tsx (fonts, theme, reduced-motion CSS)
app/page.tsx → <Console/>
components/Console.tsx            — holds run state via useRunStream(); grid layout; keyboard shortcuts (a approve, r reset with confirm, ? help)
  TopBar                           — wordmark, phase chip, SimulationBadge ("Demo suppliers · Local rules · Simulated orders"), IntegrationStatus popover, Reset
  BriefPanel (left)                — RequestEditor (textarea, event date, timezone, headcount, veg, budget, simulated clock), RequirementsCard (confirmed/assumed/missing), Confirm button
  MarketGraph (center)             — SVG: event node → 3 demand group nodes → supplier offer nodes; edges by coverage; node states candidate/selected/rejected/withdrawn/replacement/superseded; click → OfferDrawer; SignatureBanner overlay (MARKET CLEARED / PLAN RECOVERED — REVIEW CHANGES / NO FEASIBLE PLAN)
  PlanPanel (right)                — selections with change chips (kept/added/replaced/re-quoted), coverage table, totals (goods, fees, delivery, total), budget (exposure, retained, pending, remaining), schedule (last arrival, slack), unresolved conditions, Approve button (disabled with reason), orders list with simulated statuses, Infeasibility card with gap + "Raise budget to $X" action, Disruption controls (supplier select + cancel, delay offer + minutes, headcount input)
  HistoryPanel (bottom)            — event rows (seq, time, type, summary) with expandable evidence (payload JSON)
  OfferDrawer                      — price breakdown, fulfillment, constraints, provenance, selection/rejection reason (from the latest evaluation's reject codes for candidates containing this offer)
hooks/useRunStream.ts              — fetches /api/runs/current, opens EventSource with ?after=lastSeq, applies run.snapshot, appends events, reconnects with backoff, exposes command helpers that generate idempotency keys
```

Responsive: `lg` three columns; below `lg` the panels stack (brief → plan → graph → history) with the Approve button sticky at the bottom. Reduced motion: transitions disabled under `prefers-reduced-motion`; banners still appear.

Accessibility: every control keyboard reachable; graph nodes are `<g role="button" tabindex=0>` with `aria-label`; live region announces phase changes; status chips carry text.

## 11. Live reasoning adapter (`providers/live.ts`)

- SDK `@anthropic-ai/sdk`; model from `CLEARING_MODEL` (default `claude-opus-5-5`); `client.messages.parse` with `zodOutputFormat(ModelRequirementsOutput | ModelBuyerOutput | ModelSellerOutput)`; `max_tokens` 2,000; per-call timeout `CLEARING_MODEL_TIMEOUT_MS`.
- Budget: `CLEARING_MAX_MODEL_CALLS` (16) per run including retries; concurrency `CLEARING_MAX_CONCURRENT_MODEL_CALLS` (4) via a tiny semaphore; one schema-repair retry per call; cache keyed by input hash; abort when `requestVersion` moves.
- On any failure (timeout, rate limit, malformed output after repair, provider error): emit `model.fallback {component, reason}` and use the local rule for that component; the UI shows the exact component that fell back.
- Prompts: seller prompt = own public profile + own policy + the requirement slice + its thread; buyer prompt = shortlist diagnostics only. Merchant description text is wrapped as data with an explicit "untrusted" preface.
- Activation: only when `CLEARING_REASONING=live` and `ANTHROPIC_API_KEY` is set at app runtime; otherwise `IntegrationStatus.reasoning = {mode: 'local', verified: false}`.

## 12. Test matrix

| Brief requirement | Test (Vitest unless noted) |
|---|---|
| Valid plan covers quantities, dietary, timing, full cost | `solver.test.ts` fresh plan on the preset fixture: coverage rows, slack ≥ 0, `fullyPriced` |
| Cheapest individual offers do not win when incompatible | `solver.test.ts`: the cheapest coverage-complete combinations at round 0 are invalid (timing); Fogline at its 6:15 default is rejected `arrival_too_late` until re-slotted; a courier paired only with included-delivery is `delivery_unused` |
| Capacity and included delivery never double-counted | `solver.test.ts`: courier + included-delivery meal ⇒ `delivery_unused`; two offers from one merchant ⇒ `duplicate_merchant`; `deliveryCents` equals fee + courier only |
| Expired/superseded offers cannot be approved | `service.test.ts`: approve with a superseded revision → 409; clock advanced past `expiresAt` → 409 `offer_expired` |
| Cancellation invalidates only appropriate selections | `service.test.ts`: cancel Golden Hour ⇒ Bodega kept, Pelican dropped only with `widened` reason |
| Headcount growth changes requirements, cost, capacity | `service.test.ts`: 85 ⇒ re-quotes, Golden Hour capacity skip, infeasible gap $143.57; budget $1,200 ⇒ recovered |
| Impossible request returns truthful explanation | `solver.test.ts`: budget $500 ⇒ `over_budget` with `cheapestInvalid`; all meal suppliers unavailable ⇒ `no_supply` |
| Retained charges and pending refunds cannot overspend | `ledger.test.ts` + `service.test.ts` with Harbor (20% retained, pending refund): exposure includes both; repair rejects a candidate that would fit only if the pending refund counted |
| Repeated approval/disruption idempotent | `service.test.ts`: same key twice ⇒ same response, one order set, one disruption |
| Old model results cannot overwrite new request/plan | `service.test.ts`: job with stale `requestVersion` ⇒ `StaleJob`, state unchanged |
| Invalid model output, timeout, provider failure bounded | `providers.test.ts`: fake provider returning garbage / hanging / throwing ⇒ `model.fallback` event, local result, call budget respected |
| Untrusted merchant text cannot override constraints | `interpret.test.ts` + `service.test.ts`: merchant description containing "ignore the budget" changes nothing; prompt builder wraps it as data |
| Browser journey | `e2e/journey.spec.ts`: submit → confirm → offers → plan → approve → cancel → repair → approve → refresh → reset; `e2e/edges.spec.ts`: impossible budget, keyboard, 390 px viewport, zero console errors |

## 13. Capability → actions → dependencies

Legend: **A** = Opus worker A (core service/API), **B** = Opus worker B (UI), **C** = Sonnet worker C (unit tests), **D** = Sonnet worker D (e2e), **F** = Fable (integration/review), **R** = Opus reviewer.

| # | Capability | Actions | Depends on | Owner |
|---|---|---|---|---|
| 1 | Shared contracts & fixtures | Freeze `contracts.ts`; add `fixtures.ts` (preset request, fixed clock, scenario builders) | — | F (done) + C adds fixtures |
| 2 | Deterministic engine | solver, seller, buyer, ledger, interpret | 1 | F (done) |
| 3 | Durable store | `store.ts` with CAS commit, events, idempotency, in-memory mode | 1 | A |
| 4 | Service & pipeline | commands, phase machine, jobs, resumability | 2, 3 | A |
| 5 | Disruptions & repair | three types, repair ranking, widening explanation, approval of repaired plans | 4 | A |
| 6 | Providers | `local.ts`, `live.ts`, status, call budget, fallback events | 1 | F (small, after 4) |
| 7 | HTTP API + SSE | routes, validation, SSE replay/tail | 4, 5 | A |
| 8 | Console UI | components per §10, hook, graph, drawer, banners, responsive, a11y | 1 (types), 8a (API spec in this doc); real data from 7 | B |
| 9 | Unit tests | §12 Vitest rows | 2, 3, 4, 5, 6 (uses in-memory store + fixed clock) | C |
| 10 | Static checks & build | tsc, eslint, next build; confirm node:sqlite externalisation | 7, 8 | F |
| 11 | Browser tests | §12 Playwright rows + screenshots | 10 | D |
| 12 | Independent review | pricing, approvals, stale state, labels, journey | 10, 11 | R |
| 13 | Visual pass & fixes | act on screenshots and review findings | 11, 12 | F (+B for larger UI fixes) |
| 14 | Docs & delivery | README, DEMO_SCRIPT, CLAUDE.md, BUILD_PLAN update, commit, push | 13 | F |

Parallel waves: **Wave 1** = 3+4+5+7 (A), 8 (B), 9 (C, against A's in-progress store via the contracts and a fixed interface stub). **Wave 2** = 6 and 10 (F). **Wave 3** = 11 (D) and 12 (R). **Wave 4** = 13, 14 (F).

Ownership rules: only F edits `contracts.ts`, `package.json`, and config files; A owns `src/lib/store.ts`, `service.ts`, `src/app/api/**`; B owns `src/app/(page|layout|globals)`, `src/components/**`, `src/hooks/**`; C owns `tests/**` and `src/lib/fixtures.ts`; D owns `e2e/**` and `playwright.config.ts`. Workers report blockers instead of editing outside their area.

## 14. Agent front door (added after positioning review)

Purpose: show that a personal agent (Instinct, Muse, Dots or similar) could use Clearing as a
capability rather than compete with it. The front door is a thin, documented, machine-readable
surface over the same service layer. It never widens authority: an external agent can submit
and read; **approval stays with the organizer** unless `CLEARING_AGENT_CAN_APPROVE=true` is set
explicitly, and even then approval is the same idempotent command with the same revalidation.

| Method & path | Body | Response |
|---|---|---|
| `GET /api/agent` | — | Capability manifest: name, tagline, honesty labels, endpoints with input/output field lists, `simulated: true` |
| `POST /api/agent/request` | `{text, eventDate?, timezone?, nowLocal?, venueName?, idempotencyKey}` | `{runId, phase, requirements: {confirmed, assumed, missing}, nextAction: "confirm" | "fix_missing"}` |
| `POST /api/agent/confirm` | `{edits?, idempotencyKey}` | `{runId, phase: "collecting"}`; agent then polls |
| `GET /api/agent/plan` | — | `{phase, plan: {revision, totalCents, remainingCents, slackMinutes, selections[{merchant, group, totalCents, change}], unresolvedConditions, approvalRequired: true} | null, infeasibility | null, labels: {supply, reasoning, execution}}` |
| `POST /api/agent/approve` | `ApproveCommand` | 403 `{error: "approval_requires_organizer"}` unless the env flag is set; otherwise same as the console approve |

Defaults when fields are omitted: `eventDate` = next demo Friday, `timezone` = `America/Los_Angeles`, `nowLocal` = `14:00`, labelled as assumptions in the response.
Rate limit: 30 requests/minute per IP via an in-memory token bucket (demo only). Text ≤ 2,000 chars.

Text-style entry: `app/agent/page.tsx` is a minimal page with one textarea and a transcript
of the raw JSON exchanges, so a human can watch exactly what an agent would send and receive.
It links back to the console, which shows the same run live.

Owner: Sonnet worker E, Wave 2 (depends on §3 service and §8 API). Files: `src/app/api/agent/**`,
`src/app/agent/page.tsx`, `e2e/agent.spec.ts`, README section “Using Clearing from an agent”.

## 15. Ownership adjustments

- Worker A also owns `tests/service.test.ts` and `tests/store.test.ts` (it knows the store/service internals).
- Worker C owns `tests/solver.test.ts`, `tests/negotiation.test.ts`, `tests/ledger.test.ts`, `tests/interpret.test.ts`, and may extend `src/lib/fixtures.ts` additively (no renames).
- `src/lib/providers/{types,local,status}.ts` exist; A codes against `ReasoningProvider`. `live.ts` and `tests/providers.test.ts` are Fable's in Wave 2.
- `vitest.config.ts`, `eslint.config.mjs`, `playwright.config.ts` (D creates it), `package.json`: Fable approves any change.

## 16. As-built notes (service layer, Wave 1)

Recorded from the backend worker's report after verification (232 unit tests pass; REST and SSE smoke-tested).

- Job progress is derived from the job's own events (`causeId = job.id`); a negotiation round sends all asks at the start of the round and answers them one at a time with pacing between answers.
- `submitRequest` is allowed in any phase; a running job becomes stale. The preset's first interpretation keeps request version 1, so preset offer ids are `off_*_v1`.
- Confirm always retires open offers and collects again. `settleRefund` re-runs the repair automatically when the phase is `no_feasible_plan`. `updateBudget` repairs if anything was ever approved, otherwise re-runs a fresh clearing. A no-feasible outcome marks any never-approved proposed plan `superseded`.
- On approval, an order replaced by the same merchant's new revision is closed as `superseded` under carry-forward terms (full release, no retention): a supplier's own re-quote or delay never incurs that supplier's cancellation fee. The solver applies the same rule when computing repair exposure. (Changed after independent review; the earlier cancel-and-replace model produced phantom budget gaps.)
- Idempotency keys are namespaced per command; only successful responses are stored together with a fingerprint of the request body, and reusing a key with a different body is rejected (400 `idempotency_mismatch`). `request` and `confirm` accept an optional key.
- `ConfirmCommand` and `SubmitRequestCommand` live in `service.ts`; the store exposes `listEventsByCause`.
- SSE sends a snapshot whenever `run.version` changes and follows a new run from seq 0 after reset.
- Known limitations: the live provider's call ceiling is per process (resets on restart), not per run; offers expire 3 hours after creation by the real clock; an unexpected runner failure returns the run to `confirming` with a `job.failed` event; the console API has no organizer login (local demo), so only the agent front door enforces the no-approval rule; the agent rate limit keys on the client-supplied forwarded-for header and is a demo guard only.

## 17. Attendee opt-in (P1, as built)

Purpose: collect opt-in meal preferences and counts without personal data, and let the
organizer apply the aggregate to the requirements. Interest is never an order.

**Data model.** Contracts: `AttendeePreference` (`vegetarian` | `flexible`), `AttendeeResponse`
`{respondentId, preference, partySize 1–6, submittedAt}`, `AttendeeSummary` `{responses, people,
vegetarian, flexible, appliedAt, appliedPeople}`, `AttendeeLink` `{token, enabled, createdAt}`;
`Run.attendeeLink` / `Run.attendeeSummary` are optional so older runs parse. SQLite (created
next to the core schema, cleared by `deleteAll()`):

```sql
CREATE TABLE attendee_responses (run_id TEXT, respondent_id TEXT, preference TEXT, party_size INTEGER,
  submitted_at TEXT, PRIMARY KEY (run_id, respondent_id));   -- upsert: one row per respondent
CREATE TABLE attendee_links (token TEXT PRIMARY KEY, run_id TEXT NOT NULL);
```

Store: `putAttendeeLink`, `findRunIdByAttendeeToken`, `upsertAttendeeResponse`,
`listAttendeeResponses`. Pure helpers (aggregation, public view, token format) live in
`src/lib/attendee.ts`, which has no Node-only imports so the attendee page can share them.

**Service.**
- `createAttendeeLink(runId, {idempotencyKey?})`: requires requirements; 24 random bytes as a
  48-hex token; mapping row written first, then a CAS commit sets `attendeeLink` and a summary
  recomputed from stored answers (zeros for a new run). One active link per run (a second call
  returns it). Event `attendee.link_created` carries counts, never the token.
- `submitAttendee({token, respondentId, preference, partySize})`: `NotFound` unless the token
  maps to a run whose `attendeeLink` carries the same token and is enabled; upserts the answer;
  a CAS commit recomputes the summary from **all** stored answers (people = Σ partySize,
  vegetarian = Σ partySize where vegetarian, flexible = the rest), so concurrent submissions
  converge. An identical re-submission writes nothing. Event `attendee.responded`: counts only.
  Cap 800 distinct respondents per run (409 `attendee_limit`).
- `getAttendeeView(token)`: the public view (below); a disabled link reads `enabled: false`.
- `applyAttendeeCounts(runId, {idempotencyKey})`: needs a link and ≥1 response; allowed in
  `confirming` or, with no job, in `simulated_confirmed | proposed | needs_approval |
  no_feasible_plan` (else 409); identical counts → 400 `unchanged`. Sets headcount = people and
  vegetarianMin = vegetarian through `applyEdits` (both `confirmed`), adds the assumption note
  "Counts applied from N attendee responses", records `appliedAt/appliedPeople`, emits
  `attendee.applied`. In `confirming` it only bumps `requestVersion` and stores the
  requirements. Otherwise it records a `headcount_changed` disruption and calls
  `requoteForRequirements` — the helper the headcount disruption now uses too (extracted from
  `disrupt`, behaviour unchanged) — then starts the repair job: re-quote, re-negotiate, repair,
  `needs_approval` (or an honest `no_feasible_plan`).

**Routes.**

| Method & path | Who | Body | Response |
|---|---|---|---|
| `POST /api/runs/current/attendee-link` | organizer console | `{idempotencyKey?, runId?}` | `{run}` |
| `POST /api/runs/current/attendee-apply` | organizer console | `{idempotencyKey, runId?}` | `{run}` |
| `GET /api/attend/[token]` | public | — | `{objective, eventDate, timezone, readyByLocal, venueName, summary: {responses, people, vegetarian, flexible}, enabled}`; 404 unknown |
| `POST /api/attend/[token]` | public | `{respondentId, preference, partySize}` | same view; 404 unknown/disabled; 429 over limit |

`runId`, when sent, must equal the current run (409 `run_mismatch`), so a stale tab or the
static `/dev` sample cannot act on the live run. The page `app/attend/[token]` renders the
same view server-side (404 for unknown tokens, `referrer: no-referrer`, `noindex`); its client
form keeps a `crypto.randomUUID()` respondent id in `localStorage` (try/catch, in-memory
fallback). The console panel (`components/AttendeePanel.tsx`, mounted in the Brief panel)
posts through `useAttendeeCommands()` in `hooks/useRunStream.ts` and reads counts from the
run snapshot.

**Authority boundaries.** The token is a submit-only credential. Nothing reachable with it
returns the budget, plans, offers, orders, approvals, merchants, run id or token; it cannot
change requirements, spending limits or phase, approve, or trigger cancellations. Only the
organizer applies counts, and a changed package always needs fresh approval. Objective text is
stripped of currency amounts before it reaches the public view.

**Rate limit.** `POST /api/attend/[token]`: 10 per minute per client, implemented on the
shared agent token bucket (30 tokens/min) under an `attend:` key charging 3 tokens per
submission; 429 with `Retry-After`. Same caveat as §14: keyed on forwarded-for, a demo guard.

## 18. Supply assembly (P1, as built)

- A meal supplier whose capacity is below the headcount now quotes a **partial** offer (`offer.partial = {coversMeals, ofMeals}`, capacity meals with vegetarian first) instead of leaving the market; it still declines below its minimum order.
- New lever `quantity_topup`: the buyer fires it only when no candidate is feasible **and every** open meal offer is partial (no single kitchen can serve). It anchors on the largest partial offer and asks each other kitchen to quote exactly the remainder (vegetarian shortfall first); sellers enforce their minimum order and capacity, and re-evaluate volume tiers at the new quantity. A full quote is never converted into a top-up while it could still carry a plan on its own (for example once the budget rises).
- Solver: normal candidates stay at ≤3 offers (so the 60-attendee preset still evaluates 41). When any partial offer exists it also evaluates 4-offer packages with exactly two meal offers; any set with more than two meal offers is rejected `too_many_meal_offers`. Per-merchant capacity is summed across a merchant's offers as before.
- Fixture `REQUESTS.assembly` (130 attendees, $2,600): Harbor Kitchen 120 (20 vegetarian) + Golden Hour 20-meal top-up (its minimum order) + Bodega + Pelican = $1,858.02; 81 candidates, 6 feasible (`tests/split.test.ts`).
- Honesty: a partial offer carries the condition "Partial: covers N of M meals; a second meal supplier is required", and the plan lists every supplier, its covered quantity, and cost; approval is still required for the whole package.

## 19. ZooWork planner role (as built)

`src/lib/providers/zoowork.ts` is a `LiveTransport` for the existing bounded live provider, so the ZooWork path inherits the call ceiling, concurrency cap, timeout, one schema-repair retry, fallback events and the "model never owns identifiers/totals/authority" rule unchanged.

- Lifecycle (source-reviewed against `@zoowork-ai/sdk` 0.10.2): `listModels()` → selectable row whose `default_for` includes `model`; `createAgent` once with idempotency key `clearing-planner-v1`, persona doc `PLANNER_DOC`, `include_global_skills: false`; `startAgent` + `waitUntilRunning`; agent id persisted in `.data/zoowork-agent.json` (or `ZOOWORK_AGENT_ID`). One Session per reasoning call (`initial_events: [user.message]`), `streamEvents` until `run.finished`, `assistantText` concatenated, first JSON object extracted; non-`succeeded` runs or non-JSON replies return null → local fallback.
- Evidence: offline-tested (`tests/zoowork.test.ts`, fake client), not live-verified. `IntegrationStatus.zoowork.connected` flips to true only after a successful parsed reply in the running process; the `model.call` events name the transport, which is the proof that a ZooWork reply entered the pipeline.
- Not done: seller roles on ZooWork (one Agent per merchant with its private policy as persona). BAND rooms for cross-agent negotiation are §20.

## 20. BAND coordination (as built)

Boundary: `src/lib/coordination/types.ts` — `Coordinator { name; requestConcession({ask, offer, round, ctx, signal}) → ConcessionResult & {trace?}; status() }`. `ServiceDeps.coordinator` is optional; `answerStep` keeps `provider.chooseSellerLever` and then calls the coordinator *instead of* `respond()` (absent ⇒ direct `respond()`, unchanged). `offer.revised`/`offer.declined` payloads gain `coordination: "local" | "band"` and `trace {transport, roomId, askId, askMessageId, replyMessageId, note}`. `app.ts` wires `bandCoordinatorFromEnv()` when `BAND_BUYER_AGENT_ID` + `BAND_BUYER_API_KEY` exist, else `localCoordinator(CATALOG)`.

- **Buyer side** (`coordination/band.ts`): lazily loads the transport; creates one room (`POST /agent/chats`) or reuses `BAND_ROOM_ID`; per seller agent, `GET /participants` then `POST /participants {participant_id, role: member}` once (memoised). One ask = one `POST /messages` whose content starts `@<seller handle>` with `mentions: [{id, handle, name}]`, then a fenced JSON ask (`coordination/protocol.ts`, `AskPayload`): `{clearing:1, askId, offerId, offerRevision, lever, topup?, round, demandSummary{headcount, vegetarianMin, zone, nowMin}, nowIso, offer}` — budget and other suppliers never leave the buyer. Waits ≤ `BAND_REPLY_TIMEOUT_MS` (45 s) for a `ReplyPayload {clearing:1, askId, outcome, reply, offer?}` from **the mapped seller agent id**: WebSocket push (`chat_room:{id}` / `message_created`) when available, plus polling `GET /messages` (unprocessed, oldest first) every 1.5 s; consumed and stale replies are marked `processing`→`processed`.
- **Validation** (`verifySellerRevision`): `Offer` contract; same `id`/`merchantId`/`requestVersion`; `revision = current + 1`; buyer-side `respond()` on the private catalog must also revise, with identical lines (sku, qty, unit, line cents), fees, delivery, total, and slot. The accepted offer is the server-computed copy (note suffixed "· via BAND"). Mismatch ⇒ declined "reply failed validation: <why>". A seller decline is accepted as is. Timeout/abort ⇒ "BAND reply timed out"; transport error ⇒ "BAND reply timed out (transport error)" (error text never echoed; keys never logged).
- **Fallback**: merchants missing from `BAND_SELLER_AGENTS` use the local coordinator (`trace.transport = "local"`), listed in `status()` as "local fallback for …".
- **Seller side** (`coordination/seller-agent.ts`, run by `scripts/band-seller.mts` via `Agent.create({agentId, apiKey, adapter: new GenericAdapter(...)})` + `agent.run()`): ignores anything without a valid `AskPayload` for its own merchant (and, with `BAND_BUYER_AGENT_ID`, from anyone but the buyer); answers `respond()` with the demand rebuilt from the summary; replies via `tools.sendMessage(content, [{id: buyer}])`. The reply object has exactly `clearing, askId, outcome, reply, offer?`.
- **Status** (`coordination/band-state.ts`, read by `providers/status.ts`): not configured ⇒ "Not connected — …"; configured ⇒ "Configured: negotiation runs through a BAND room (buyer agent + seller agent processes); unverified until a round trip completes", `coordination: "BAND room (unverified; local fallback)"`; after a parsed seller reply in this process ⇒ `connected: true`, "Live-verified: room <id>, N round trips", `coordination: "BAND room (live-verified)"` (`IntegrationStatus.coordination` widened to this enum).
- **Tests** (`tests/band.test.ts`, fake transport): room created once and reused (and `BAND_ROOM_ID` reuse); one @mention + JSON per ask, no budget; honest reply ⇒ revised offer equal to local policy with full trace; tampered price ⇒ declined "reply failed validation"; impostor sender ignored; timeout and transport errors ⇒ declined, no secret leak; unmapped merchant ⇒ local; seller handler ignores junk and never emits policy keys; preset pipeline over fake BAND clears at the same total with `coordination: "band"`; silent BAND still finishes the run.
- **Unverified without credentials**: real room creation, participant add across agents, mention delivery, WebSocket push, handle format, and the SDK run loop in `band-seller.mts`. `npm view @band-ai/sdk` = 0.5.0; calls were checked against its `.d.ts` and the docs.band.ai Agent API pages, not against the live service.

## 21. Supplier discovery (Moss, as built)

Discovery answers "which suppliers might exist for this request?" and is strictly separate from the executable market (HLD §2): its output is unverified candidates for display, never offers. It changes no run state.

- **Modules** (`src/lib/discovery/`): `directory.ts` (fictional 18-entry directory: the 7 catalog merchants with ids and names from `catalog-public.ts` and searchable text built from their public profile, plus 11 invented suppliers with `executable: false` and `why_not_executable`); `types.ts` (`DiscoveryProvider`, `DiscoveryResult`, and `readDiscoveryEvent`, the browser-safe reader of the journaled event); `local.ts` (deterministic keyword matcher: tokenise, IDF-weighted overlap, fixed zone bonus, entries with no topical overlap dropped, `score: null`); `moss.ts` (Moss adapter). Provider selection is in `app.ts` (`appDiscovery()`): Moss when `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY` are present, else local.
- **Moss API used** (typings: `node_modules/@moss-dev/moss/dist/moss.d.ts`, v1.7.x): `new MossClient(projectId, projectKey)`, `createIndex(name, docs)` (throws if the index exists; an "already exists" error is treated as reuse), `loadIndex(name)` (downloads the index so queries run in memory), `query(name, text, { topK, alpha })` returning `{ docs: [{ id, text, score, metadata }] }`. Index `clearing-suppliers` is created once per process; preparation retries once; a failed preparation is not cached. The SDK is imported lazily with bundler-ignore comments because it ships a native addon. `MossClient` is server-side only.
- **Trust.** Returned ids are looked up in the local directory; name, `executable` and note come only from that entry, unknown ids and duplicates are dropped, and the service re-checks `executable` against its own catalog. Moss's metadata and text are untrusted data and never reach a prompt.
- **Pipeline step** (extends §4): the first collect step of a job calls `discovery.discover(requirementsSummary, { topK: 10, zone })` under a 5 s bound (`ServiceDeps.discovery`, `discoveryTimeoutMs`) after `market.opened` and before any `supplier.entered`. Query text is built from confirmed requirements only (objective, headcount, vegetarian count, items, zone). Success is one `model.call` event, payload `{ component: "discovery", engine, indexed, ms, candidates: [{ id, name, score, executable, note }], summary, zone, topK, provider }`; failure or timeout is one `model.fallback` `{ component: "discovery", reason }`. The step is resumable (it is skipped when the job's journal already holds a discovery event), does not count toward `run.modelCalls`, and leaves the run row unchanged. `contracts.ts` is untouched: candidates live only in the event payload.
- **Status.** `discoveryStatus()` (separate from `IntegrationStatus`) reports `moss` or `local-keyword`; Moss is `connected` only after a successful query in this process.
- **UI** (extends §10.2): `DiscoveryPanel` in `PlanPanel` reads the newest discovery event from the history (`events` prop; the Console passes the stream's events). Header "Discovered suppliers", subtitle `<engine> · <n> indexed · <ms> ms · unverified candidates, not offers`, rows with rank, an executable check (opens that merchant's market node) or "not executable — <note>". Before market open: "Runs at market open." Rank only; a Moss score appears solely as a tooltip labelled "retrieval score (Moss)".
- **Tests** (`tests/discovery.test.ts`): directory shape; local provider (all 7 executable merchants in the top 10, alcohol and AV excluded, deterministic, zone changes rank); Moss provider with an injected fake client (single `createIndex`, hybrid query mapping, retry, failure leaves status not connected); service (event placement and payload, discovery failure or timeout still reaches the same proposed plan, 6 offers, 41 candidates checked).
- **Unverified without credentials:** a real `createIndex`/`loadIndex`/`query` round trip, Moss latency, and the semantic quality of its ranking.
