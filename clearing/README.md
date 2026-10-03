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
| Reasoning | **Local rules** (deterministic request interpretation and negotiation) | Set `CLEARING_REASONING=live` and `ANTHROPIC_API_KEY` in `.env.local`. Live mode replaces exactly two components: request interpretation and counteroffer lever choice. It is implemented but **unverified** in this build because no key was available; failures fall back to local rules and are recorded as `model.fallback` events. |
| Supply | **Fictional demo catalog** (`src/lib/catalog.ts`) | Tavily discovery is documented in `docs/LLD.md` but not enabled; search results could only ever be unverified candidates. |
| Coordination | **Local transport** (in-process pipeline, SSE to the browser) | ZooWork and BAND are **not connected**; required setup is recorded in `BUILD_PLAN.md`. |
| Execution | **Simulated orders**, simulated charges and refunds | Not changeable in this build. |

The integration status popover in the UI reads `/api/status`, which checks credentials by
presence only and never prints values.

## Configuration

Copy `.env.example` to `.env.local`. Variables: `CLEARING_REASONING`, `ANTHROPIC_API_KEY`,
`CLEARING_MODEL`, `CLEARING_MAX_MODEL_CALLS`, `CLEARING_MAX_CONCURRENT_MODEL_CALLS`,
`CLEARING_MODEL_TIMEOUT_MS`, `CLEARING_PACE_MS` (readability pacing between real supplier
events; 0 in tests), `CLEARING_DB_PATH`, `CLEARING_AGENT_CAN_APPROVE`, and placeholders for
`TAVILY_API_KEY`, `ZOOWORK_API_KEY`, `BAND_API_KEY`. Secrets never reach the browser bundle.

## Verification

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (flat config from eslint-config-next)
npm test            # vitest unit tests
npm run build       # next build
npm run test:e2e    # playwright against `next start` on :3100 (pre-installed Chromium)
npx tsx scripts/simulate.ts   # design-time diagnostic: pure modules through the flagship scenario
```

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
