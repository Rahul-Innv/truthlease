# Clearing

**Your event. Supplied. Even when plans change.**

Clearing is an AI organizer with a marketplace behind it. Describe what an already-booked
gathering needs; fictional demo suppliers compete with structured offers; a deterministic
clearing engine combines them into one feasible, fully priced package; when a supplier
cancels, delivery slips, or attendance changes, Clearing proposes a repaired plan and asks
for fresh approval. Built for small hackathons, meetups, and team gatherings.

> Every run is labelled **Demo suppliers · Local rules · Simulated orders**. "Market
> cleared" means a feasible proposed solution exists for the modelled requirements. No
> real reservation, purchase, or delivery ever happens in this build.

## Run it locally

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`). No credentials needed.

```bash
cd clearing
npm install
npm run dev          # http://localhost:3100
```

Production mode (what the browser tests run against):

```bash
npm run build && npm start
```

State lives in `clearing/.data/clearing.sqlite` (git-ignored). The **Reset** control in the
top bar, or `POST /api/reset`, deletes all runs and recreates the editable preset.

## The demo

See `DEMO_SCRIPT.md` for the happy path, the disruptions, and the honest no-feasible-plan
fallback. The preset request is editable; the event date defaults to the next Friday and
the simulated event clock starts at 2:00 PM on that date (America/Los_Angeles, editable).

## Modes and integration status

| Axis | This build | How to change |
|---|---|---|
| Reasoning | **Local rules** (deterministic request interpretation and negotiation) | Two live options replace exactly two components (request interpretation and counteroffer lever choice): `CLEARING_REASONING=live` with `ANTHROPIC_API_KEY`, or `CLEARING_REASONING=zoowork` with `ZOOWORK_API_KEY`, which runs the planner/buyer role on a ZooWork Managed Agent (created once as `clearing-planner`, reused across restarts). Both are implemented and offline-tested but **unverified live** here because no key was available; failures fall back to local rules and are recorded as `model.fallback` events. Verify ZooWork with `npx tsx scripts/zoowork-verify.mts`. |
| Supply | **Fictional demo catalog** (`src/lib/catalog.ts`) | Tavily discovery is documented in `docs/LLD.md` but not enabled; search results could only ever be unverified candidates. |
| Coordination | **Local transport** (in-process pipeline, SSE to the browser) | BAND coordination mode is implemented and offline-tested but **unverified live** (no BAND credentials here): see [BAND coordination mode](#band-coordination-mode). |
| Execution | **Simulated orders**, simulated charges and refunds | Not changeable in this build. |

The integration status popover in the UI reads `/api/status`, which checks credentials by
presence only and never prints values.

## Supplier discovery (Moss)

When a market opens, Clearing runs one **supplier discovery** step and journals the answer as a
single `model.call` event with `component: "discovery"` (a failure is a `model.fallback` with the
same component, and the market opens regardless). The plan panel shows it as "Discovered
suppliers": retrieval rank, whether each candidate is executable, and for the rest
"not executable — no authorized offer or policy in the demo catalog".

- **Candidates, not offers.** Discovery searches a fictional 18-entry directory: the 7 executable
  demo-catalog merchants plus 11 invented, display-only suppliers (a bagel shop, AV rentals, a bar
  service, and so on). It never filters, adds, or changes a catalog merchant, so the solver sees
  exactly the same market with or without it (the preset still receives 6 offers and evaluates
  41 candidate combinations). A candidate is executable only if its id is in the catalog; the
  service re-checks that, and Moss's returned text and metadata are never trusted.
- **Engines.** With `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY` set, a `@moss-dev/moss` client creates
  (once per process) and loads an index named `clearing-suppliers` and queries it hybrid
  (`alpha` 0.6, `topK` 10) in memory. Without them a deterministic local keyword matcher is used
  and reports `score: null`. The UI never presents a retrieval score as confidence.
- **Status.** Moss counts as connected only after a successful query in the running process
  (`discoveryStatus()` in `src/lib/providers/status.ts`). The offline tests use an injected fake
  client; a live run against portal.usemoss.dev has not been performed here. The index is created
  on first use and reused afterwards; delete it in the Moss portal to re-seed after changing
  `src/lib/discovery/directory.ts`.
- **Bounds.** 5 s timeout, one retry of index preparation, and the index is warmed in the
  background at startup so the first run is not slow.

## BAND coordination mode

**What is real.** With BAND configured, a seller's answer to a concession ask no longer comes
from an in-process function call. The buyer agent (inside the Clearing server) creates one BAND
chat room, adds each mapped seller agent, and posts one message per ask that @mentions that
seller with a JSON ask (`{clearing: 1, askId, offerId, offerRevision, lever, topup?, round,
demandSummary, nowIso, offer}` — no budget, no other suppliers). Each seller is a separate
process (`scripts/band-seller.mts`) holding only its own merchant and private policy; it prices
the revision with `seller.respond` and replies @mentioning the buyer (`{clearing: 1, askId,
outcome, reply, offer?}` — never its floor, tiers or round cap). Only seller agents see asks
addressed to them (BAND's mention-scoped routing), so removing the room removes the negotiation.

**What code still owns.** The buyer trusts nothing in the room: the reply must come from the
mapped seller agent and match the ask id, and a revised offer must parse as the `Offer`
contract, keep id/merchant/request version, advance the revision by exactly one, and match
the totals that merchant's policy allows (re-priced on the buyer side). Otherwise it is a
decline with "reply failed validation". No reply within `BAND_REPLY_TIMEOUT_MS` (default 45 s)
or a transport error is a decline ("BAND reply timed out"), so the pipeline always finishes.
Negotiation events carry `coordination: "band"` plus a `trace` with the room id, ask id and
both BAND message ids — that is the evidence. Status flips to "Live-verified: room <id>, N
round trips" only after a seller reply actually arrived through BAND in the running process.

**What you need.**
1. Sign up at [app.band.ai](https://app.band.ai) (free tier; hackathon code `BANDSEP26` if useful).
2. Agents → Remote Agent: register one **buyer** agent and **one per seller** you want on BAND
   (e.g. `m-juniper`, `m-goldenhour`, `m-fogline`, `m-pelican`). Copy each Agent UUID and its
   API key (shown once). Sibling agents under one owner can be added to the buyer's room.
3. In `.env.local`: `BAND_BUYER_AGENT_ID`, `BAND_BUYER_API_KEY`, and
   `BAND_SELLER_AGENTS={"m-juniper":"<uuid>", ...}`. Unmapped merchants answer in-process and are
   listed as "local fallback" in the coordinator status.
4. One terminal per seller:
   `BAND_SELLER_MERCHANT=m-juniper BAND_AGENT_ID=<uuid> BAND_API_KEY=<key> BAND_BUYER_AGENT_ID=<buyer uuid> npx tsx scripts/band-seller.mts`
5. `npm run dev`, run the preset, and open the room in the BAND console to watch the asks and replies.

Transport: `@band-ai/sdk` 0.5.0 — the buyer uses `BandLink` REST calls (create chat, list/add
participants, send message with mentions, list unprocessed messages, mark processed) plus the
`chat_room:{id}` WebSocket for push delivery, polling the messages endpoint as a fallback; sellers
use `Agent.create` + `GenericAdapter` + `agent.run()`. In this demo every seller process is built
from the same repository, so the policy boundary is the process and the room, not separate codebases.

## Configuration

Copy `.env.example` to `.env.local`. Variables: `CLEARING_REASONING`, `ANTHROPIC_API_KEY`,
`CLEARING_MODEL`, `CLEARING_MAX_MODEL_CALLS`, `CLEARING_MAX_CONCURRENT_MODEL_CALLS`,
`CLEARING_MODEL_TIMEOUT_MS`, `ZOOWORK_API_KEY`, `ZOOWORK_BASE_URL`, `ZOOWORK_AGENT_ID`, `CLEARING_PACE_MS` (readability pacing between real supplier
events; 0 in tests), `CLEARING_DB_PATH`, `CLEARING_AGENT_CAN_APPROVE`, and placeholders for
`TAVILY_API_KEY`, `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, `ZOOWORK_API_KEY`, and the BAND set
(`BAND_BUYER_AGENT_ID`, `BAND_BUYER_API_KEY`, `BAND_SELLER_AGENTS`, `BAND_ROOM_ID`,
`BAND_REPLY_TIMEOUT_MS`, `BAND_WS_URL`, `BAND_REST_URL`). Secrets never reach the browser bundle.

## Verification

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (flat config from eslint-config-next)
npm test            # vitest: 269 unit tests across 11 files
npm run build       # next build
npm run test:e2e    # playwright: full journey + edges, desktop and mobile, against `next start` on :3100
npx tsx scripts/simulate.ts   # design-time diagnostic: pure modules through the flagship scenario
```

The browser suite resets the app through `POST /api/reset`, drives the real UI from the preset
to reset (confirm → offers → MARKET CLEARED $784.40 → approve → cancel Golden Hour →
PLAN RECOVERED $994.14 → approve → reload → headcount 85 → NO FEASIBLE PLAN, gap $143.57 →
raise budget → PLAN RECOVERED $1,143.57 → reset), and asserts zero console output. It uses the
pre-installed Chromium that matches `@playwright/test` 1.56.1; do not run `playwright install`.

## P1: supply assembly

When no single kitchen can serve the headcount (try 130 attendees with a $2,600 budget), meal
suppliers quote partial offers up to their capacity, the buyer asks the other kitchens for
top-up quantities, and the solver assembles at most two meal suppliers plus the necessary
courier into one package. Every supplier, quantity, cost and the approval still required are
shown. Partial quotes never replace a full quote that could carry a plan on its own.

## Attendee opt-in (P1)

The organizer can create a shareable attendee link from the Brief panel ("Attendee opt-in").
Each person who opens it on their phone picks **Vegetarian** or **Flexible** and a party size
(1–6). The console shows live aggregate counts, and **Apply counts to requirements** sets the
headcount and vegetarian minimum from them. Before confirmation this only edits the request;
once a plan exists it follows the same path as a headcount change (re-quote, repair) and the
repaired plan needs fresh approval.

- **What it collects:** a preference, a party size, and a random per-browser id (kept in the
  browser so a person can change their own answer). No names, emails, phone numbers or other
  personal data. Event logs record counts only.
- **What it never does:** an answer is not an order, a reservation or a payment, and the page
  says so. The link cannot see the budget, plan, offers, orders or run id, cannot approve,
  cancel or change anything, and has no way into the console. Only the organizer applies counts.
- **Guards:** the 48-character token is a submit-only credential kept out of the event log;
  unknown or closed links answer 404; submissions are limited to 10 per minute per client
  (demo guard, same forwarded-for caveat as the agent limiter) and 800 respondents per run.

## Security notes for this build

- No organizer login: the console API is the organizer's surface on a local machine, not a
  security boundary. The agent front door refuses approval so an integration cannot approve
  by accident. A multi-user deployment would need authentication on the console routes.
- The agent routes carry a demo-only rate limit keyed on the forwarded-for header.
- Seller policy lives only in `src/lib/catalog.ts` (server); browser code imports
  `src/lib/catalog-public.ts`. The client bundle contains the Zod schema shape, never values.
- Idempotency keys are bound to a fingerprint of the request body; reusing a key with a
  different body is rejected.

## Using Clearing from an agent

A thin machine-readable front door lets a personal agent use Clearing as a capability: it can
**submit, confirm and read**. **Approval stays with the organizer** in the console; the approve
endpoint answers `403 approval_requires_organizer` unless the operator sets
`CLEARING_AGENT_CAN_APPROVE=true` (then it is the same idempotent command with the same
revalidation). Suppliers are fictional and orders are simulated; every response is labelled.
The `/agent` page runs the same calls from a browser and shows the raw JSON exchanged
(design: `docs/LLD.md` §14).

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/agent` | none | Capability manifest: labels, endpoints with input and output fields, authority note |
| `POST /api/agent/request` | `{text, idempotencyKey, eventDate?, timezone?, nowLocal?, venueName?}` | `{runId, phase, requirements: {confirmed, assumed, missing, values}, assumptionsApplied, nextAction: "confirm" or "fix_missing"}` |
| `POST /api/agent/confirm` | `{idempotencyKey, edits?}` | `{runId, phase: "collecting"}`; the market opens in the background |
| `GET /api/agent/plan` | none | `{phase, nextAction, plan, infeasibility, labels}`; poll until `phase` is `proposed` |
| `POST /api/agent/approve` | `{planRevision, idempotencyKey}` | `403` by default; with the flag, the same `{run}` as the console |

`text` is at most 2,000 characters and is treated as data. Idempotency keys are 8-80
characters; replaying one returns the original result. Omitted `eventDate` (next demo Friday),
`timezone` (`America/Los_Angeles`) and `nowLocal` (`14:00`) are reported in
`assumptionsApplied`. When `nextAction` is `fix_missing`, send the missing values as `edits`
on `/confirm` (for example `{"edits": {"budgetCents": 100000}}`). All `/api/agent` routes share
an in-memory limit of 30 requests per minute per client (`429` with `Retry-After`).

```bash
BASE=http://localhost:3100
curl -s $BASE/api/agent                                  # manifest

curl -s -X POST $BASE/api/agent/request -H 'content-type: application/json' -d '{
  "text": "Dinner for 60 hackathon attendees at our already-booked venue. At least 20 need vegetarian meals; the rest are flexible. Include nonalcoholic drinks, plates, and utensils. Everything ready by 6:30 PM. Maximum $1,000 including all fees and delivery.",
  "idempotencyKey": "demo-request-0001"
}'                                                       # nextAction: "confirm"

curl -s -X POST $BASE/api/agent/confirm -H 'content-type: application/json' \
  -d '{"idempotencyKey": "demo-confirm-0001"}'           # phase: "collecting"

curl -s $BASE/api/agent/plan                             # repeat until "phase": "proposed"

curl -s -X POST $BASE/api/agent/approve -H 'content-type: application/json' \
  -d '{"planRevision": 1, "idempotencyKey": "demo-approve-0001"}'   # 403: the organizer approves in the console
```

## Deployment limitations

Clearing is designed for one long-lived Node process: background pipeline steps run
in-process and state is a local SQLite file. A serverless host would lose both. There is no
public deployment, no paid provisioning, and no real-world fulfillment.

## Layout

```
src/lib/contracts.ts   shared Zod schemas (single source of truth)
src/lib/catalog.ts     fictional merchants (private policy never leaves the server)
src/lib/solver.ts      deterministic clearing engine
src/lib/seller.ts      seller quoting and concession rules
src/lib/buyer.ts       buyer shortlist and lever strategy
src/lib/ledger.ts      simulated money and budget exposure
src/lib/store.ts       SQLite persistence (runs + append-only events + idempotency)
src/lib/service.ts     commands, phase machine, pipeline, repair
src/lib/providers/     local rules | live model adapter | integration status
src/app/api/           REST + SSE route handlers
src/components/        operations console
docs/HLD.md, docs/LLD.md, BUILD_PLAN.md, DEMO_SCRIPT.md
```
