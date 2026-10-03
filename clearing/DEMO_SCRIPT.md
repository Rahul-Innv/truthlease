# Clearing — demo script (≈4 minutes)

Start: `npm run build && npm start` → open http://localhost:3100 → press **Reset** so the
preset is fresh. The badge reads *Demo suppliers · Local rules · Simulated orders*.

## 1. Request → requirements (30 s)
- Read the preset aloud: dinner for 60, at least 20 vegetarian, drinks, plates, utensils,
  ready by 6:30 PM, max $1,000.
- Point at the requirements card: confirmed fields, the two assumptions (fictional venue,
  20-minute setup buffer), nothing missing. Optional: delete "$1,000" from the text and
  re-submit to show the *missing budget* state, then put it back.
- Click **Confirm requirements**.

## 2. Market forms and negotiates (45 s)
- Suppliers enter one by one (paced for readability; each is a stored event). Harbor
  Kitchen Collective declines: minimum order 75 meals.
- Round 0: no feasible plan yet. The event log shows why (timing, budget).
- Round 1: Golden Hour Taqueria moves to ready 5:00 PM and applies a 5% volume price;
  Fogline Beverage Co. moves to 4:30 PM; Bodega Marquez declines (fixed prices).
  Round 2: Juniper & Rye Catering applies 8%.
- Click a supplier node (or Tab to it and press Enter) to open the offer drawer: price
  breakdown, timing, provenance, and a labelled browser re-check of why it lost.

## 3. MARKET CLEARED (30 s)
- Banner: *MARKET CLEARED — feasible proposed solution for the modelled requirements*.
- Plan panel: Golden Hour Taqueria $565.40 + Bodega Marquez $147.00 + Pelican Couriers
  $72.00 = **$784.40**; remaining $215.60; last arrival 5:50 PM, slack 20 min;
  41 candidates checked. Coverage table shows 20 vegetarian + 40 standard, 60 drinks,
  plates, utensils.
- Click **Approve simulated orders**. Orders appear as *simulated-placed* → *simulated-confirmed*.

## 4. Disruption 1: supplier cancels (45 s)
- Disruption controls → **Simulate supplier cancellation** → Golden Hour Taqueria.
- The node turns withdrawn; its order is cancelled (full refund, settled). Phase: repairing.
- Banner: *PLAN RECOVERED — REVIEW CHANGES*. Plan revision 2: Juniper & Rye $803.14
  (replaces Golden Hour), Bodega **kept**, Swiftline Runners $44.00 (replaces Pelican —
  keeping Pelican would have exceeded the budget; the panel says so). Total **$994.14**.
- Approve again. Only the changed orders are re-placed; Bodega's order is untouched. The
  banner now reads *PLAN RECOVERED* (the "review changes" suffix drops once approved).

## 5. Disruption 2: attendance 60 → 85 (45 s)
- Change headcount to 85 in the disruption controls. Meal and drink offers re-quote at the
  new quantities; the courier is untouched.
- Banner: *NO FEASIBLE PLAN*. The card shows the exact gap: cheapest otherwise-valid option
  Bodega + Harbor Kitchen + Swiftline at **$1,143.57**, **$143.57 over** $1,000. Dietary
  requirements are never relaxed automatically.
- Click **Raise budget to $1,143.57**. Banner: *PLAN RECOVERED — REVIEW CHANGES*. Harbor
  Kitchen Collective (capacity 120) replaces Juniper & Rye; Bodega is re-quoted at 85;
  Swiftline Runners is kept. Approve.

## 6. Refresh and reset (15 s)
- Refresh the page: the approved plan and orders are still there; nothing re-executes.
- Optional: **Simulate delivery delay** on a supplier's own delivery (+5 min on Harbor) to
  show a same-supplier revision that carries the order forward with no cancellation fee;
  +25 min on the courier shows a timing repair.
- Optional: cancel every meal supplier to show the blocked *no supply* state.
- **Reset** returns to the preset.

## Honest framing to say out loud
- Suppliers are fictional; offers come from deterministic policy functions; orders are simulated.
- The numbers are computed by the solver from the catalog, not scripted; editing the request changes them.
- "Optimal" is only among the candidates actually evaluated (41 for the 6 offers quoted
  at 60 attendees).
- Live-model mode exists but is unverified here; ZooWork, BAND and Tavily are not connected.
- An external agent can submit and read via `/agent` and `/api/agent`, but cannot approve.
