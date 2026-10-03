"use client";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Offer, Run } from "@/lib/contracts";
import { NODE_STATE_META, closestPackageFor, mealCoverage, type MarketNode } from "./derive";
import { GROUP_LABEL, LEVER_LABEL, MODE_LABEL, REJECT_LABEL, activePlan, clockTime, formatCents, formatLocal, planById } from "./format";
import { Button, Chip, Glyph, KV, cx } from "./ui";

const STATE_TONE = {
  selected: "mint",
  replacement: "mint",
  candidate: "accent",
  rejected: "neutral",
  withdrawn: "red",
  superseded: "neutral",
  awaiting: "neutral",
  no_quote: "neutral",
} as const;

const STATE_GLYPH = {
  selected: "check",
  replacement: "swap",
  candidate: "ring",
  rejected: "cross",
  withdrawn: "cross",
  superseded: "dash",
  awaiting: "half",
  no_quote: "ring",
} as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Why({ run, node }: { run: Run; node: MarketNode }) {
  const plan = activePlan(run);
  const o = node.offer;
  const explanation = useMemo(() => (o && (node.state === "rejected" || node.state === "candidate") ? closestPackageFor(run, o) : null), [run, o, node.state]);

  if (node.state === "selected" && plan) {
    return (
      <div className="space-y-1.5 text-[13px] leading-snug">
        <p className="flex gap-2 text-text">
          <Glyph name="check" className="mt-1 text-mint" />
          Selected in plan r{plan.revision}
          {node.tag ? ` (${node.tag})` : ""}.
        </p>
        <p className="text-muted">{plan.reason}</p>
      </div>
    );
  }
  if (node.state === "replacement" && plan) {
    const rep = plan.changeSummary.replaced.find((r) => r.to === node.merchantName);
    return (
      <div className="space-y-1.5 text-[13px] leading-snug">
        <p className="flex gap-2 text-text">
          <Glyph name="swap" className="mt-1 text-mint" />
          Replacement in repaired plan r{plan.revision}
          {rep ? ` for ${rep.from}` : ""}. Needs approval before any simulated order changes.
        </p>
        {rep ? <p className="text-muted">Why: {rep.why}</p> : null}
        {plan.changeSummary.widened ? <p className="text-muted">{plan.changeSummary.widened}</p> : null}
      </div>
    );
  }
  if (node.state === "superseded") {
    const prev = plan ? planById(run, plan.basedOnRevision) : null;
    return (
      <div className="space-y-1.5 text-[13px] leading-snug">
        <p className="flex gap-2 text-text">
          <Glyph name="dash" className="mt-1 text-muted" />
          {prev && plan ? `Was in plan r${prev.revision}; the repaired plan r${plan.revision} drops it.` : "This offer has no open revision."}
        </p>
        {plan?.changeSummary.widened ? <p className="text-muted">{plan.changeSummary.widened}</p> : null}
        <p className="text-muted">Any active simulated order stays in place until the repaired plan is approved, then it is cancelled under the supplier&rsquo;s terms.</p>
      </div>
    );
  }
  if (node.state === "withdrawn") {
    return (
      <p className="flex gap-2 text-[13px] leading-snug text-text">
        <Glyph name="cross" className="mt-1 text-red" />
        Withdrawn: {run.availability[node.merchantId]?.reason ?? "offer withdrawn"}. Withdrawn offers are never selectable.
      </p>
    );
  }
  if (node.state === "awaiting" || node.state === "no_quote") {
    return <p className="text-[13px] leading-snug text-text">{node.skippedReason ? `Declined to quote: ${node.skippedReason}.` : node.state === "awaiting" ? "Has not quoted yet." : "No quote for the current request."}</p>;
  }
  if (node.state === "candidate" && !plan) {
    return <p className="text-[13px] leading-snug text-text">Open offer. The market has not cleared yet, so nothing is selected or rejected.</p>;
  }
  // rejected (or candidate with a plan)
  if (!o) return <p className="text-[13px] text-text">Not in the selected package.</p>;
  if (!explanation) {
    return (
      <p className="text-[13px] leading-snug text-text">
        Not in the selected package. Offer status: <span className="font-mono">{o.status}</span>.
      </p>
    );
  }
  const names = explanation.offers.map((x) => x.merchantName).join(" + ");
  const repair = Boolean(plan?.basedOnRevision);
  return (
    <div className="space-y-2 text-[13px] leading-snug">
      {explanation.rejects.length === 0 ? (
        <p className="text-text">
          Feasible in <span className="font-medium">{names}</span> ({formatCents(explanation.totalCents)}), but not chosen: the selected plan ranks first on {repair ? "fewest changes, then exposure" : "lowest all-in cost, then slack"}.
        </p>
      ) : (
        <>
          <p className="text-text">
            Not in the selected package. Closest package containing this offer: <span className="font-medium">{names}</span> ({formatCents(explanation.totalCents)}).
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {explanation.rejects.map((code) => (
              <li key={code}>
                <Chip tone="red" glyph="cross" title={code}>
                  {REJECT_LABEL[code]}
                  {code === "over_budget" ? <span className="num font-normal"> +{formatCents(explanation.exposureCents - explanation.budgetCents)}</span> : null}
                </Chip>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-xs text-muted">
        <span className="font-medium text-text">Browser re-check · server authoritative.</span> The solver&rsquo;s own rules, re-run against this snapshot over {explanation.candidatesTried} packages containing this offer.
      </p>
    </div>
  );
}

function Price({ o }: { o: Offer }) {
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th scope="col" className="py-1 pr-3 text-left font-normal">
              Item
            </th>
            <th scope="col" className="whitespace-nowrap py-1 pl-3 text-right font-normal">
              Qty
            </th>
            <th scope="col" className="whitespace-nowrap py-1 pl-4 text-right font-normal">
              Unit
            </th>
            <th scope="col" className="whitespace-nowrap py-1 pl-4 text-right font-normal">
              Line
            </th>
          </tr>
        </thead>
        <tbody className="num">
          {o.lines.map((l) => (
            <tr key={l.sku} className="border-t border-line/60 align-top">
              <td className="py-1.5 pr-3 text-text">{l.label}</td>
              <td className="whitespace-nowrap py-1.5 pl-3 text-right text-muted">{l.qty}</td>
              <td className="whitespace-nowrap py-1.5 pl-4 text-right text-muted">{formatCents(l.unitCents)}</td>
              <td className="whitespace-nowrap py-1.5 pl-4 text-right text-text">{formatCents(l.lineCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-2 border-t border-line pt-1.5">
        {o.fees.map((f) => (
          <KV key={f.label} label={f.label}>
            {formatCents(f.cents)}
          </KV>
        ))}
        <KV label="Delivery">{o.deliveryCents === null ? <span className="text-muted">none (pickup)</span> : formatCents(o.deliveryCents)}</KV>
        <KV label="Total" emphasis>
          {formatCents(o.totalCents)}
        </KV>
      </dl>
    </>
  );
}

export function OfferDrawer({ run, node, onClose }: { run: Run; node: MarketNode | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = node !== null;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // React's autoFocus fires before showModal(); focus the Close button once the dialog is modal.
      closeRef.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const merchant = node ? run.merchants.find((m) => m.id === node.merchantId) : undefined;
  const o = node?.offer ?? null;
  const negotiation = o ? run.negotiation.filter((n) => n.offerId === o.id) : [];
  const meal = o ? mealCoverage(run, o) : null;
  const partialRow =
    meal && (meal.partial || meal.topup) ? (
      <KV label={meal.topup ? "Partial quote · top-up" : "Partial quote"}>
        covers {meal.covers}
        {meal.of !== null ? ` of ${meal.of}` : ""} meals
      </KV>
    ) : null;
  const tz = run.request.timezone;

  return (
    <dialog
      ref={ref}
      aria-labelledby="drawer-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="sheet border-l border-line bg-surface p-0 text-text shadow-2xl shadow-black/60"
    >
      {node ? (
        <div className="scroll-thin flex h-full flex-col overflow-y-auto">
          <header className="sticky top-0 z-10 border-b border-line bg-surface px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted">
                  {GROUP_LABEL[node.group]}
                  {o ? ` · ${MODE_LABEL[o.fulfillment.mode]}` : ""}
                </p>
                <h2 id="drawer-title" className="mt-0.5 text-lg font-semibold leading-tight text-text">
                  {node.merchantName}
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Chip tone={STATE_TONE[node.state]} glyph={STATE_GLYPH[node.state]}>
                    {NODE_STATE_META[node.state].label}
                  </Chip>
                  {o ? (
                    <span className="font-mono text-xs text-muted">
                      {o.id} · v{o.requestVersion} · r{o.revision} · {o.status}
                    </span>
                  ) : null}
                </div>
              </div>
              <Button ref={closeRef} variant="ghost" size="sm" onClick={onClose} aria-label="Close offer details">
                Close
              </Button>
            </div>
          </header>

          <Section title="Selection">
            <Why run={run} node={node} />
          </Section>

          {o ? (
            <>
              <Section title="Price">
                <Price o={o} />
              </Section>
              <Section title="Fulfillment">
                <dl>
                  {partialRow}
                  <KV label="Mode">{MODE_LABEL[o.fulfillment.mode]}</KV>
                  <KV label={o.fulfillment.mode === "pickup_only" ? "Ready for pickup" : "Arrives at venue"}>{formatLocal(o.fulfillment.timeLocal)}</KV>
                  {o.fulfillment.pickupByLocal ? <KV label="Pickups ready by">{formatLocal(o.fulfillment.pickupByLocal)}</KV> : null}
                  {o.fulfillment.maxPickups !== undefined ? <KV label="Max pickups">{o.fulfillment.maxPickups}</KV> : null}
                  <KV label="Slot">
                    <span className="font-mono text-xs">{o.fulfillment.slotId}</span>
                  </KV>
                  <KV label="Expires">{clockTime(o.expiresAt, tz)}</KV>
                </dl>
              </Section>
              <Section title="Conditions">
                {o.conditions.length === 0 && o.unpriced.length === 0 ? (
                  <p className="text-[13px] text-muted">No conditions. Fully priced.</p>
                ) : (
                  <ul className="space-y-1">
                    {o.conditions.map((c) => (
                      <li key={c} className="flex gap-2 text-[13px] leading-snug text-text">
                        <Glyph name="warn" className="mt-1 text-amber" />
                        {c}
                      </li>
                    ))}
                    {o.unpriced.map((u) => (
                      <li key={u} className="flex gap-2 text-[13px] leading-snug text-red">
                        <Glyph name="cross" className="mt-1" />
                        Unpriced: {u}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Provenance">
                <p className="text-[13px] text-text">
                  Demo catalog · {o.provenance.reasoning === "local" ? "Local rules" : "Live model (validated)"} · round {o.provenance.round}
                </p>
                <p className="mt-0.5 text-xs text-muted">{o.provenance.note}</p>
                <p className="mt-0.5 text-xs text-muted">Quoted {clockTime(o.createdAt, tz)} · request v{o.requestVersion}</p>
              </Section>
              {node.revisions.length > 1 || negotiation.length ? (
                <Section title="Revisions and negotiation">
                  <ol className="space-y-2">
                    {node.revisions.map((r) => (
                      <li key={`${r.id}@${r.revision}`} className={cx("flex items-baseline gap-2 text-[13px]", r === o ? "text-text" : "text-muted")}>
                        <span className="w-28 shrink-0 font-mono text-xs">
                          v{r.requestVersion} · r{r.revision}
                        </span>
                        <span className="min-w-0 flex-1 leading-snug">{r.provenance.note}</span>
                        <span className="num shrink-0">{formatCents(r.totalCents)}</span>
                      </li>
                    ))}
                  </ol>
                  {negotiation.length ? (
                    <ul className="mt-3 space-y-2 border-t border-line pt-3">
                      {negotiation.map((n) => (
                        <li key={n.id} className="text-[13px] leading-snug">
                          <p className="text-muted">
                            Round {n.round} · asked for {LEVER_LABEL[n.lever]}: <span className="text-text">{n.ask}</span>
                          </p>
                          <p className={n.outcome === "revised" ? "text-mint" : "text-muted"}>
                            {n.outcome === "revised" ? `Revised → r${n.resultRevision ?? "?"}` : "Declined"}: <span className="text-text">{n.reply}</span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Section>
              ) : null}
            </>
          ) : null}

          {merchant ? (
            <Section title="Supplier profile">
              <dl>
                <KV label="Tagline">{merchant.tagline}</KV>
                <KV label="Service zones">{merchant.serviceZones.join(", ")}</KV>
                {merchant.capacity.maxMeals !== undefined ? <KV label="Max meals">{merchant.capacity.maxMeals}</KV> : null}
                {merchant.minMeals !== undefined ? <KV label="Min meals">{merchant.minMeals}</KV> : null}
                {merchant.capacity.maxDrinkServings !== undefined ? <KV label="Max drink servings">{merchant.capacity.maxDrinkServings}</KV> : null}
                {merchant.capacity.maxPickups !== undefined ? <KV label="Max pickups">{merchant.capacity.maxPickups}</KV> : null}
                <KV label="Lead time">{merchant.leadTimeMinutes} min</KV>
                <KV label="Cancellation">{merchant.cancellation.refundablePct}% refundable</KV>
              </dl>
              <p className="mt-1 text-xs leading-snug text-muted">{merchant.cancellation.note}</p>
              <div className="mt-3 rounded-md border border-dashed border-line px-3 py-2">
                <p className="text-xs text-muted">Supplier description · untrusted text, shown as data</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-text">{merchant.description}</p>
              </div>
              <p className="mt-2 text-xs text-muted">Fictional demo supplier. Prices, capacity and slots are modelled inputs.</p>
            </Section>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
