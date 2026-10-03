# Clearing: AI Commerce Gallery submission

**Your event. Supplied. Even when plans change.**

## 1. Pitch

Clearing is an AI organizer with a marketplace behind it. Describe an already-booked gathering; supplier offers compete and are negotiated into one feasible, fully priced package; the organizer approves; and when a supplier cancels or headcount changes, Clearing repairs the plan and asks for fresh approval.

## 2. The problem and who pays

Organizers of small events (hackathons, meetups, team dinners) coordinate food, drinks and delivery by text, then redo it when a caterer cancels or attendance moves. The small caterers and couriers who supply them are hard to find and quote one request at a time.

- **Revenue (suppliers):** get found and compete for whole packages, not single orders.
- **Efficiency (organizers):** one brief replaces a thread of texts; changes are re-planned, not renegotiated by hand.
- **Risk:** feasibility (budget, deadline, dietary coverage) is validated, and nothing is ordered without explicit organizer approval.

These are the lines Clearing is designed to move. This build measures none of them; it shows only cost, capacity, slack and candidates checked.

## 3. What Clearing is

A market mechanism, not a chatbot: **request, competing offers, bounded negotiation that changes real terms** (ready times, volume prices), **deterministic clearing** (the solver owns totals and feasibility, never a model), **approval, disruption, repair, re-approval.**

- **Agent front door:** a personal agent can submit, confirm and read through `/api/agent`. Approval stays with the organizer (403 by default).
- **Attendee opt-in:** a shareable link collects Vegetarian or Flexible plus party size, with no personal data; the organizer applies the counts.
- **Supply assembly:** when no single kitchen can serve the headcount, up to two kitchens plus a courier form one package.

## 4. Live demo for judges (90 seconds)

Setup: `npm run build && npm start`, open http://localhost:3100, press **Reset**.

1. **(0:00)** Preset: dinner for 60, at least 20 vegetarian, drinks, plates, utensils, ready by 6:30 PM, max $1,000. Click **Confirm requirements**.
2. **(0:10)** Suppliers quote; Harbor Kitchen declines (minimum 75). Round 0 has no feasible plan; rounds 1 and 2 change real terms.
3. **(0:25)** **MARKET CLEARED, $784.40**: Golden Hour $565.40 + Bodega Marquez $147.00 + Pelican $72.00. Click **Approve simulated orders**.
4. **(0:35)** **Simulate supplier cancellation** on Golden Hour. **PLAN RECOVERED, $994.14**: Juniper & Rye $803.14, Bodega kept, Swiftline $44.00 replaces Pelican (the panel explains keeping Pelican would exceed budget: the courier is widened). Approve; only changed orders are re-placed.
5. **(0:55)** Set headcount to 85. **NO FEASIBLE PLAN**: the cheapest valid option is $1,143.57, **$143.57** over budget; dietary needs are never relaxed. Click **Raise budget to $1,143.57**: the plan recovers at $1,143.57.
6. **(1:15)** Reset, then 130 attendees with a $2,600 budget. No kitchen serves 130 alone (max 120), so two assemble: Harbor 120 + Golden Hour 20-meal top-up + Bodega + Pelican, **$1,858.02**, one approval. Rehearse this step; it edits the request.

The numbers are computed by the solver, not scripted.

## 5. Honesty box

**Real:** the deterministic solver and negotiation, integer-cent money, idempotent commands with optimistic versioning, an append-only event log in local SQLite, approval gating, persistence across refresh.

**Simulated:** every supplier is fictional (demo catalog); orders, charges and refunds are simulated. MARKET CLEARED means a feasible proposed solution for the modelled requirements, never a reservation, purchase or delivery. Seller "agents" are deterministic policy functions; a real supplier-side surface is the next step.

**Reasoning:** local rules by default. The live-model adapter (request interpretation and counteroffer lever choice only) is implemented and unit-tested with a fake transport, but **unverified live** because no key was available.

**Integrations, exactly as BUILD_PLAN §2 states:**

| Integration | Status |
|---|---|
| Live model (Anthropic) | not connected; adapter unverified live |
| ZooWork | adapter implemented: the planner/buyer role runs on a ZooWork Managed Agent (SDK 0.10.2), offline-tested; **not live-verified** in the build environment (no key). With `CLEARING_REASONING=zoowork` and `ZOOWORK_API_KEY`, `npx tsx scripts/zoowork-verify.mts` proves it in one call |
| BAND | adapter implemented: buyer agent posts asks into a BAND room, seller agents answer by @mention as separate processes, replies are re-priced against policy before use; offline-tested (16 tests); **not live-verified** (needs registered BAND agents) |
| Moss | supplier discovery over a fictional directory via Moss hybrid search; results are unverified candidates, never offers; offline-tested; **not live-verified** (needs MOSS_PROJECT_ID/KEY) |
| Tavily | web discovery appended as unverified candidates with source URL and retrieval time; offline-tested; **not live-verified** (needs TAVILY_API_KEY) |

Setup for each is documented. ZooWork, BAND, Moss and Tavily are wired into the real pipeline behind the same validation as every other external source, and each is claimed only to the extent a live-verified run exists at submission time. Entire is configured at the repo level (`.entire/settings.json`) and must be enabled from a developer machine. Other limits: no organizer login, one long-lived Node process, no public deployment.

## 6. Judging criteria

1. **Approach & Idea:** gives the organizer's personal agent a market to act in, for a real chore (event supply), with approval kept human.
2. **Technical Execution:** the primary features run live locally with no credentials; the solver is deterministic and every command is idempotent and verified by tests.
3. **Presentation:** a 90-second path with real, recomputable numbers, and honesty framing said aloud.
4. **Design:** an operations console with three clear states, an exact gap plus a one-click fix, an offer drawer showing why a supplier lost, and a phone-sized attendee page. Desktop and mobile are browser-tested.
5. **X-Factor:** the repair that explains itself, an honest "no" with the exact $143.57 gap, and two kitchens assembled when none can serve alone.

## 7. Run and verify

```bash
cd clearing && npm install      # Node >= 22.13, no credentials
npm run dev                     # http://localhost:3100
npm run typecheck && npm run lint
npm test                        # 269 unit tests, 11 files
npm run build && npm start
npm run test:e2e                # Playwright: 13 passed, 1 skipped by project filter
```

Counts are as recorded in BUILD_PLAN §5; re-run before presenting. Do not run `playwright install`.

## 8. Team and links

- Team: [name]
- Repo: https://github.com/Rahul-Innv/truthlease (folder clearing/, branch claude/build-clearing-marketplace-t9gbx8)
- Demo video: [link]
