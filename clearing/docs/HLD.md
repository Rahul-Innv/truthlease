# Clearing — High-Level Design

*Your event. Supplied. Even when plans change.*

Status: design approved for implementation pending sign-off · Scope: P0 hackathon build · Owner: lead engineer (Fable) · Executors: Opus/Sonnet workers

---

## 1. What Clearing is

Clearing is an AI organizer with a marketplace behind it. An organizer describes what an already-booked gathering needs. Fictional demo suppliers submit structured offers. A deterministic clearing engine combines offers into one feasible package. When a supplier cancels, delivery slips, or attendance changes, Clearing proposes a repaired plan that preserves what still works, and asks for fresh approval before any (simulated) spend.

First niche: small hackathons, startup meetups, team gatherings. Three capability groups: meals; drinks and consumables; delivery/fulfillment.

**Non-goals (P0):** real payments, live purchases, external messaging, venue booking, alcohol, ticketing, CRM, merchant onboarding, generalized agent frameworks, production routing. P1 (deferred): attendee preference page, two-supplier meal split.

## 2. The honesty model

Every run visibly distinguishes four axes. The default badge reads **“Demo suppliers · Local rules · Simulated orders”**.

| Axis | Default (shipped) | Alternative (feature-flagged, needs credentials) |
|---|---|---|
| Reasoning | Deterministic local rules | Live model for request interpretation and counteroffer *suggestion* only |
| Supply | Fictional demo catalog | Tavily results stored as *unverified candidates*, never executable offers |
| Coordination | Local in-process transport | ZooWork / BAND — recorded as *not connected* unless real credentials and a real handoff exist |
| Execution | Simulated orders, simulated charges and refunds | None in this build |

Rules that follow from this model:
- “MARKET CLEARED” means *a feasible proposed solution exists for the modelled requirements*. The badge copy says so.
- Model output never owns identifiers, revisions, totals, authorization, or event sequence numbers.
- No fabricated probabilities, confidence scores, savings, or reliability metrics. Shown facts: cost, capacity, deadline slack, candidates checked, changed selections, solver time.
- Local-mode offer arrival is paced (~350 ms per supplier) only for readability. Every transition is a stored event; pacing is labelled and never counted as supplier response time.
- A live model negotiating with fictional suppliers is still simulated commerce and is labelled per component, never “live marketplace”.

## 3. System context

```
┌───────────────────────────────── Browser (Next.js App Router, React 19) ─────────────────────────────────┐
│  Request editor │ Market graph (SVG) │ Plan panel + approval │ Event history │ Offer drawer │ Disruptions │
│                 ▲ SSE /api/runs/:id/events (replay from seq, then tail)        │ REST commands (JSON)     │
└─────────────────┼─────────────────────────────────────────────────────────────┼──────────────────────────┘
                  │                                                             ▼
┌──────────────────────────────── Next.js server (single long-lived Node process) ─────────────────────────┐
│  Route handlers (validate with Zod) ──► Service layer (commands, phase machine, idempotency, jobs)       │
│        │                                   │            │              │               │                 │
│        │                      ┌────────────┘            │              │               │                 │
│        ▼                      ▼                         ▼              ▼               ▼                 │
│  Interpreter          Seller policies            Buyer strategy    Clearing solver   Ledger (simulated)  │
│  (local rules │ live) (private per merchant)     (shortlist/levers) (enumerate,      (charges, refunds,  │
│                                                                      validate, rank)  exposure)          │
│        │                                                                                                 │
│        ▼                                                                                                 │
│  Store: SQLite (node:sqlite, WAL) — runs (versioned JSON state) + events (append-only) + idempotency     │
│                                                                                                          │
│  Adapters (status surfaced in UI): Anthropic (live reasoning) · Tavily (discovery) · ZooWork · BAND      │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Transport: server-sent events over a durable event table. The client replays from its last sequence number, then tails. Polling against the same endpoint is the fallback.

## 4. Core flow

```
request ──► requirements (confirmed / assumed / missing)
        ──► confirm
        ──► market opens: each eligible supplier enters and quotes (round 0)
        ──► negotiation: ≤2 targeted rounds change concrete offer terms (price tier, slot)
        ──► clearing: deterministic solver picks the best feasible candidate
        ──► proposed plan ──► organizer approves ──► simulated orders placed → simulated-confirmed
        ──► disruption (supplier unavailable | delivery delayed | headcount changed)
        ──► repair: invalidate affected, preserve the rest, re-quote what must change, re-solve
        ──► repaired plan (needs approval) ──► approve ──► changed orders only are re-placed
        ──► no feasible plan: exact budget gap, or blocked when no supply remains
```

## 5. Components

| Component | Responsibility | Owner of truth for |
|---|---|---|
| `contracts` | One Zod schema per boundary (browser, store, model) | Shapes |
| `catalog` | Fictional merchants with public profile and *private* seller policy | Supply |
| `interpret` | Text + form → requirements with per-field status | Requirement extraction |
| `seller` | Quote from own catalog; respond to concession levers within policy | Offer revisions |
| `buyer` | Shortlist feasible/near-miss candidates; derive targeted lever requests | Negotiation asks |
| `solver` | Enumerate ≤3-offer candidates; validate; rank; explain | Feasibility, totals, choice |
| `ledger` | Simulated charges, cancellations, refunds, exposure | Money state |
| `store` | SQLite persistence; one transaction per command | Durability, sequence numbers |
| `service` | Commands, phase machine, idempotency, versioning, jobs, events | State transitions |
| `providers` | Local or live reasoning behind one interface; integration status | Model boundary |
| `api` | Validated REST + SSE | Transport |
| `ui` | Operations console | Presentation only |

## 6. Phase machine

```
draft ─submit─► confirming ─confirm─► collecting ─► negotiating ─► clearing ─┬─► proposed ─approve─► approved ─► simulated_confirmed
                                                                              └─► no_feasible_plan
simulated_confirmed ─disrupt─► disrupted ─► repairing ─┬─► needs_approval ─approve─► approved ─► simulated_confirmed
                                                       └─► no_feasible_plan ─(budget edit / supplier returns)─► repairing
any ─reset─► draft (preset)        any ─edit request─► confirming (requestVersion++)
```

Plan readiness (proposed / approved) is separate from order fulfillment (simulated_placed / simulated_confirmed / cancelled / superseded).

## 7. Consistency and safety invariants

- **Integer cents** everywhere; fees itemised; unknown required cost ⇒ unresolved condition ⇒ not fully priced ⇒ not approvable.
- **Server-owned identity.** IDs, revisions, sequence numbers, totals, and approvals come only from the server.
- **Idempotency.** Every mutating command carries an idempotency key; the stored response is replayed on repeats.
- **Optimistic versioning.** A run row has `version`; writes compare-and-swap inside one SQLite transaction with the event append. Jobs carry the `requestVersion` they started from and their results are rejected if the request moved.
- **Revalidation before approval.** The exact selected offer revisions are re-validated (open, unexpired, merchant available, capacity, timing, pricing, budget) at approval time.
- **Refresh safety.** State and events persist together; refreshing never re-executes orders.
- **Pending refunds never restore spendable budget.** Exposure = committed + retained + pending refunds.
- **Fresh approval for every changed package**, even when the replacement is cheaper.
- **Untrusted text.** Merchant descriptions and retrieved pages are data; they cannot change budgets, dietary constraints, or authority.

## 8. Where AI is allowed

| Allowed for a model | Owned by code |
|---|---|
| Interpreting the organizer's text into candidate requirement values | Validation, date/timezone/venue/clock, field status, confirmation |
| Suggesting which permitted lever to ask a shortlisted seller | Shortlist, caps (≤6 asks/round, ≤2 rounds, ≤16 calls total, ≤4 concurrent), validation |
| Suggesting which permitted response a seller gives (own catalog/policy only) | Floors, slots, quantity limits, capacity, revision numbering |
| Brief user-facing decision reasons | Arithmetic, feasibility, budget, expiry, state transitions, approvals |

Isolation: a seller prompt contains only that seller's catalog, policy, the relevant requirement slice, and its own thread. The buyer never sees seller policy.

## 9. Runtime and deployment

Designed for one long-lived local Node process (`next start`). SQLite lives at `clearing/.data/`. Background jobs run in-process; the pipeline is resumable from stored state if the process restarts. Serverless hosts would lose in-process jobs and local files; this is documented, not worked around. No public deployment, no paid provisioning.

## 10. Verification strategy

- Unit (Vitest): solver, seller, buyer, ledger, service — twelve required cases from the brief plus the designed fixtures.
- Static: `tsc --noEmit`, ESLint, `next build`.
- Browser (Playwright, pinned Chromium): submit → confirm → offers → plan → approve → cancel → repair → approve → refresh → reset; impossible budget; keyboard; mobile viewport; console errors; screenshots inspected.
- Independent review (Opus) challenging pricing, approvals, stale state, labels, and the full journey. Critical findings fixed before docs.

## 11. Risks and decisions log

| Risk | Decision |
|---|---|
| Next.js bundling `node:sqlite` | Load via `process.getBuiltinModule("node:sqlite")`; verified in a Node 22.22 check; confirm in the first build |
| Pre-installed Chromium 1194 | Pin `@playwright/test` 1.56.1; never run `playwright install` |
| No credentials | Local rules are the shipped path; adapters are implemented, flagged, labelled unverified |
| Headcount 85 at $1,000 is infeasible | Keep it: the honest gap ($143.57) is the demo; raising the budget to $1,200 recovers |
| GitHub push 403 | Commits stay local until the Claude GitHub App is authorized |
