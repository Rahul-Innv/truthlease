# Clearing — build plan

Working name: **Clearing**. Tagline: *Your event. Supplied. Even when plans change.*

This file records the brief assessment, the revised P0 scope, decisions, verified
integration status, and progress. It is kept current during the build.

## 0. Brief assessment (≈600 words)

**Context.** The workspace (`truthlease/`) is an unrelated Express + MCP recall
containment app with its own npm lockfile, Vitest suite, and Vercel config. Per the
brief's own default, Clearing is built as an isolated `clearing/` project on the
designated branch. A brand-new GitHub repository cannot be created from this session
(GitHub scope is limited to `rahul-innv/truthlease`); the project is self-contained so
it can be split out later with `git subtree split -P clearing`.

**Keep.** The core loop (request → competing offers → valid plan → disruption →
repaired plan), integer-cent arithmetic, a deterministic solver that owns totals and
feasibility, server-assigned IDs/revisions/sequence numbers, idempotent approval and
disruption commands, optimistic request/plan versioning, a durable event log driving the
UI, explicit simulation labels, and the three signature states (MARKET CLEARED, PLAN
RECOVERED, NO FEASIBLE PLAN).

**Simplify.**
- *Agents.* With no runtime credentials present (checked by presence: no Anthropic,
  ZooWork, BAND, or Tavily keys), the shipped path is **local rules**: seller
  "agents" are deterministic policy functions over hidden per-merchant rules
  (price floor, permitted volume discount, delivery slots, min/max quantity). The
  buyer side is a deterministic shortlist-and-counter routine. A live-model adapter
  replaces exactly two components (request interpretation and counteroffer
  suggestion) and is feature-flagged; it is *implemented but unverified live*.
- *Transport.* SSE over a durable SQLite event table (`node:sqlite`, no native
  build step), with replay from a sequence cursor. No queues, no sockets.
- *Storage.* One run row holds the authoritative run state as validated JSON plus
  a `version` for optimistic locking; events are a separate append-only table
  written in the same transaction.
- *Graph.* Plain React/SVG with a fixed three-column layout (event → demand groups →
  supplier offers). No graph library.
- *Pacing.* Offer arrival in local mode is paced (~350 ms) only so a human can watch;
  every transition is a stored event and the pacing is labelled. Solver time and
  candidates checked are measured, not pacing.

**Change.**
- "Delivery" is modelled as a *fulfillment dependency*, not a demand item: pickup-only
  offers require a courier offer; included-delivery offers do not. This is what
  prevents charging delivery twice.
- Dietary coverage is a two-constraint check: vegetarian meals ≥ vegetarian need, and
  total meals ≥ headcount, where vegetarian meals may serve flexible attendees but
  standard meals never satisfy the vegetarian need.
- Budget exposure after a cancellation is `budget − committed − retained − pending
  refunds`. Pending refunds never restore spendable budget until settled.
- The headcount disruption re-quotes offers at the new quantities (quantities are
  part of the offer), then prefers the same merchants to minimise change.

**Defer (P1, only after P0 is verified).** Group demand (attendee page) and supply
assembly (two meal suppliers + courier). Equipment rentals. Tavily discovery is
implemented as an adapter but only activates with a key.

**Contradictions / risks found in the brief.**
- "Live AI mode" and "no runtime credentials" cannot both be demonstrated here; the
  UI shows the exact component that is live, never the whole market.
- "Observed run duration" would be dominated by readability pacing; the UI reports
  solver time and candidates checked instead, and labels pacing.
- Approval after a cheaper repair still requires explicit approval; the brief says
  this twice in different words and the state machine follows it.
- "Market cleared" is defined as *feasible proposed solution over modelled inputs*;
  the badge copy says so.

**Genuine blockers.** None for the local demo. Live model, ZooWork, BAND, and Tavily
need credentials that are not present; their status is recorded below as *not
connected* with the documented setup.

**Smallest complete version.** One Next.js app: editable preset → requirement
extraction with missing-field detection → confirmation → paced offer collection →
two bounded negotiation rounds that change real offer terms → deterministic clearing →
approval creating simulated orders → three typed disruptions (supplier unavailable,
delivery delayed, headcount changed) → repair with change summary and fresh approval →
honest infeasible/blocked states → reset → persistence across refresh.

**Verification.** Vitest unit tests over fixtures (solver, ledger, idempotency,
stale-result rejection, untrusted merchant text, provider failure handling);
`tsc --noEmit`; ESLint; `next build`; Playwright journey against the production
server (submit → confirm → offers → plan → approve → cancel → repair → approve →
refresh → reset, plus impossible budget, keyboard, mobile viewport, console errors)
with screenshots inspected and visual corrections applied.

## 1. Decisions

| Area | Decision |
|---|---|
| Stack | Next.js 16 App Router, React 19, TypeScript 5.9, Tailwind 4, Zod 4 |
| Storage | `node:sqlite` (Node ≥ 22.13) via `process.getBuiltinModule`, WAL mode, file at `clearing/.data/clearing.sqlite` (git-ignored) |
| Events | Append-only `events` table; SSE route replays from `?after=<seq>` then tails |
| Money | Integer cents everywhere; fees itemised; unknown required cost ⇒ unresolved condition |
| IDs | Server-generated; offers are `(offerId, revision)`; plans are run-scoped revisions |
| Idempotency | `idempotencyKey` per command persisted with its response |
| Concurrency | `run.version` optimistic check inside one SQLite transaction; async jobs carry the `requestVersion` they started with and are rejected if it moved |
| Reasoning | `local` (default) or `live` (needs `ANTHROPIC_API_KEY` at app runtime) |
| Tests | Vitest for units; Playwright 1.56.1 pinned to the pre-installed Chromium |

## 2. Integration status (verified by presence of credentials, never by value)

| Integration | Status | Needs |
|---|---|---|
| Live model (Anthropic) | not connected | `ANTHROPIC_API_KEY`, `CLEARING_REASONING=live` |
| ZooWork | not connected | see §4 after research |
| BAND | not connected | see §4 after research |
| Tavily | not connected | `TAVILY_API_KEY` |

## 3. Progress

- [x] Workspace inspected; brief assessed; plan recorded.
- [x] HLD and LLD written (`docs/HLD.md`, `docs/LLD.md`); design validated by `scripts/simulate.ts`.
- [x] Contracts and fixtures.
- [x] Solver + negotiation + ledger (pure modules typecheck; simulation matches the designed scenario).
- [ ] Agent front door (added after positioning review; Wave 2).
- [ ] Store, events, service layer, API.
- [ ] UI vertical slice.
- [ ] Disruptions, repair, approvals.
- [ ] Tests, build, browser journey, visual pass.
- [ ] Docs (README, DEMO_SCRIPT, CLAUDE.md).

## 4. Integration research notes (from documentation read on 2026-10-03)

- **ZooWork** — managed agent runtime (Developer Preview). Auth: project key `ZOOWORK_API_KEY` (`zwp_live_…`) as `Authorization: Bearer`; SDK `@zoowork-ai/sdk`; flow `POST /agents` → `/start` → `/sessions` → `/events` → SSE stream. Requires a funded org balance. Status: **not connected**.
- **BAND** — agent coordination rooms. Auth: per-agent `agent_id` + `api_key` created in the app.band.ai UI, header `X-API-Key`; SDK `@band-ai/sdk`; REST `POST /chats`, `/chats/{id}/participants`, `/chats/{id}/messages` with @mentions; WebSocket needed to receive. Free tier. Status: **not connected**.
- **Tavily** — search API. Auth: `Authorization: Bearer tvly-…`; `POST https://api.tavily.com/search` with `query`, `search_depth`, `max_results`, `include_raw_content`; results carry `url/title/content/score` only (no prices, inventory, or availability). 1,000 free credits/month. Status: **not connected**; adapter deferred.
- **Next.js 16** — route handlers are dynamic by default; SSE via `new Response(ReadableStream, {headers: {"Content-Type": "text/event-stream"}})`; `proxy.ts` replaces `middleware.ts`; `serverExternalPackages` for Node-only deps (not needed for `node:sqlite` loaded via `process.getBuiltinModule`).
- **Event** — The AI Commerce Gallery Hackathon (ZooWork × AI Valley), Walt Disney Family Museum, San Francisco, 2026-10-03; awards include Best Use of ZooWork; Tavily and BAND are partners.
