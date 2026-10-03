"use client";
import { useId, useState, type ReactNode } from "react";
import type { DisruptionInput, Plan, Run } from "@/lib/contracts";
import type { ApprovalGate } from "./derive";
import {
  CHANGE_META,
  GROUP_LABEL,
  ITEM_LABEL,
  ORDER_STATUS_META,
  PHASE_META,
  REJECT_LABEL,
  activePlan,
  currentPlan,
  formatCents,
  formatLocal,
  offerTimeText,
  plural,
} from "./format";
import { Button, Chip, EmptyState, Glyph, KV, SectionHeader, cx } from "./ui";

const inputClass =
  "w-full rounded-md border border-line bg-ink px-2.5 py-1.5 text-sm text-text hover:border-muted/50 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";

// ---------------------------------------------------------------------------
// Budget meter (status meter: every segment is also listed as text below)
// ---------------------------------------------------------------------------

function BudgetMeter({ plan }: { plan: Plan }) {
  const b = plan.budget;
  const other = Math.max(0, b.exposureCents - b.planCents - b.retainedCents - b.pendingRefundCents);
  const scale = Math.max(b.budgetCents, b.exposureCents, 1);
  const segs = [
    { key: "plan", cents: b.planCents, cls: "bg-mint", label: "This plan" },
    { key: "retained", cents: b.retainedCents, cls: "bg-red", label: "Retained" },
    { key: "pending", cents: b.pendingRefundCents, cls: "bg-amber", label: "Pending refunds" },
    { key: "drop", cents: other, cls: "bg-amber/60", label: "Cancellation cost" },
  ].filter((s) => s.cents > 0);
  const over = b.exposureCents > b.budgetCents;
  return (
    <div className="pt-1">
      <div className="relative flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-line/60" role="img" aria-label={`Exposure ${formatCents(b.exposureCents)} of ${formatCents(b.budgetCents)} budget`}>
        {segs.map((s) => (
          <span key={s.key} className={cx("h-full first:rounded-l-full last:rounded-r-full", s.cls)} style={{ width: `${(s.cents / scale) * 100}%` }} title={`${s.label}: ${formatCents(s.cents)}`} />
        ))}
        {over ? <span className="absolute top-0 h-full w-[2px] bg-text" style={{ left: `${(b.budgetCents / scale) * 100}%` }} title="Budget limit" /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Selections({ run, plan, onOpenOffer }: { run: Run; plan: Plan; onOpenOffer: (merchantId: string) => void }) {
  const repaired = Boolean(plan.basedOnRevision);
  const offerFor = (id: string, rev: number) => run.offers.find((o) => o.id === id && o.revision === rev);
  const dropped = [
    ...plan.changeSummary.removed.map((name) => ({ name, why: "Dropped from the package" })),
    ...plan.changeSummary.replaced.map((r) => ({ name: r.from, why: `Replaced by ${r.to} · ${r.why}` })),
  ];
  return (
    <Block title="Selections" aside={<span className="num text-xs text-muted">{plural(plan.selections.length, "supplier")}</span>}>
      <ul className="-mx-2">
        {plan.selections.map((s) => {
          const o = offerFor(s.offerId, s.offerRevision);
          const ch = CHANGE_META[s.change] ?? CHANGE_META.added!;
          const carries = s.deliversFor?.map((id) => run.offers.find((x) => x.id === id)?.merchantName).filter(Boolean);
          return (
            <li key={`${s.offerId}@${s.offerRevision}`}>
              <button
                type="button"
                onClick={() => onOpenOffer(s.merchantId)}
                className="w-full rounded-md px-2 py-2 text-left hover:bg-surface-2"
                aria-label={`${s.merchantName}, ${formatCents(s.totalCents)}${repaired ? `, ${ch.label}` : ""}. Open offer details.`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{s.merchantName}</span>
                  <span className="num text-sm text-text">{formatCents(s.totalCents)}</span>
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  {repaired ? (
                    <Chip tone={ch.tone} glyph={ch.glyph}>
                      {ch.label}
                    </Chip>
                  ) : null}
                  <span>{GROUP_LABEL[s.group]}</span>
                  <span aria-hidden>·</span>
                  <span className="font-mono">r{s.offerRevision}</span>
                  {o ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>{offerTimeText(o)}</span>
                    </>
                  ) : null}
                  {carries?.length ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>carries {carries.join(" + ")}</span>
                    </>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {dropped.map((d) => (
          <li key={`drop-${d.name}`} className="px-2 py-2">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-muted line-through decoration-muted/70">{d.name}</span>
              <Chip tone="neutral" glyph="dash">
                Removed
              </Chip>
            </span>
            <span className="mt-1 block text-xs leading-snug text-muted">{d.why}</span>
          </li>
        ))}
      </ul>
      {plan.changeSummary.widened ? (
        <p className="mt-2 flex gap-2 rounded-md border border-amber/30 bg-amber/[0.06] px-2.5 py-2 text-xs leading-snug text-text">
          <Glyph name="warn" className="mt-0.5 text-amber" />
          <span>
            <span className="font-medium text-amber">Widened repair · </span>
            {plan.changeSummary.widened}
          </span>
        </p>
      ) : null}
    </Block>
  );
}

function Totals({ plan }: { plan: Plan }) {
  const b = plan.budget;
  return (
    <Block title="Cost and budget">
      <dl>
        <KV label="Goods">{formatCents(plan.totals.goodsCents)}</KV>
        <KV label="Fees">{formatCents(plan.totals.feesCents)}</KV>
        <KV label="Delivery">{formatCents(plan.totals.deliveryCents)}</KV>
        <div className="my-1 border-t border-line/70" />
        <KV label="Total" emphasis>
          {formatCents(plan.totals.totalCents)}
        </KV>
      </dl>
      <div className="mt-2">
        <BudgetMeter plan={plan} />
        <dl className="mt-1.5">
          <KV label="Budget">{formatCents(b.budgetCents)}</KV>
          <KV label={<span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-mint" aria-hidden />This plan</span>}>{formatCents(b.planCents)}</KV>
          <KV label={<span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-red" aria-hidden />Retained</span>}>{formatCents(b.retainedCents)}</KV>
          <KV label={<span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-amber" aria-hidden />Pending refunds</span>}>{formatCents(b.pendingRefundCents)}</KV>
          {b.exposureCents - b.planCents - b.retainedCents - b.pendingRefundCents > 0 ? (
            <KV label={<span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-amber/60" aria-hidden />Cancellation cost</span>}>{formatCents(b.exposureCents - b.planCents - b.retainedCents - b.pendingRefundCents)}</KV>
          ) : null}
          <KV label="Exposure">{formatCents(b.exposureCents)}</KV>
          <KV label="Remaining" emphasis>
            <span className={b.remainingCents < 0 ? "text-red" : undefined}>{formatCents(b.remainingCents)}</span>
          </KV>
        </dl>
        <p className="mt-1 text-xs leading-snug text-muted">Pending refunds never restore spendable budget until they settle.</p>
      </div>
    </Block>
  );
}

function Schedule({ plan }: { plan: Plan }) {
  const s = plan.schedule;
  return (
    <Block title="Schedule">
      <dl>
        <KV label="Ready by">{formatLocal(s.readyByLocal)}</KV>
        <KV label="Latest arrival" hint="after setup buffer">
          {formatLocal(s.latestArrivalLocal)}
        </KV>
        <KV label="Last arrival">{formatLocal(s.lastArrivalLocal)}</KV>
        <KV label="Slack" emphasis>
          <span className={s.slackMinutes < 0 ? "text-red" : undefined}>{s.slackMinutes} min</span>
        </KV>
      </dl>
    </Block>
  );
}

function Coverage({ plan }: { plan: Plan }) {
  const c = plan.coverage;
  // Required meals come from the plan's own demand (veg + flexible), never from a newer request.
  const head = (c.meal_vegetarian?.required ?? 0) + (c.meal_standard?.required ?? 0);
  const vegSup = c.meal_vegetarian?.supplied ?? 0;
  const stdSup = c.meal_standard?.supplied ?? 0;
  const rows: { label: string; required: number; supplied: number; note?: string }[] = [
    { label: "Meals (all)", required: head, supplied: vegSup + stdSup },
    { label: ITEM_LABEL.meal_vegetarian, required: c.meal_vegetarian?.required ?? 0, supplied: vegSup },
    { label: ITEM_LABEL.meal_standard, required: c.meal_standard?.required ?? 0, supplied: stdSup, note: "flex" },
    ...(["drink_serving", "plate", "utensil_set"] as const)
      .filter((k) => (c[k]?.required ?? 0) > 0 || (c[k]?.supplied ?? 0) > 0)
      .map((k) => ({ label: ITEM_LABEL[k], required: c[k]?.required ?? 0, supplied: c[k]?.supplied ?? 0 })),
  ];
  return (
    <Block title="Coverage">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th className="py-1 text-left font-normal">Item</th>
            <th className="w-[4.25rem] py-1 text-right font-normal">Required</th>
            <th className="w-[4.25rem] py-1 text-right font-normal">Supplied</th>
            <th className="w-[4.5rem] py-1 text-right font-normal">
              <span className="sr-only">Status</span>
            </th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((r) => {
            const flex = r.note === "flex";
            const ok = r.supplied >= r.required;
            return (
              <tr key={r.label} className="border-t border-line/60">
                <td className="py-1.5 pr-2 text-text">
                  {r.label}
                  {flex ? <span className="block text-xs text-muted">vegetarian may cover</span> : null}
                </td>
                <td className="py-1.5 text-right text-muted">{r.required}</td>
                <td className="py-1.5 text-right text-text">{r.supplied}</td>
                <td className="py-1.5 text-right">
                  {flex ? (
                    <span className="text-xs text-muted">info</span>
                  ) : ok ? (
                    <span className="inline-flex items-center gap-1 text-xs text-mint">
                      <Glyph name="check" />
                      met
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-red">
                      <Glyph name="cross" />
                      short {r.required - r.supplied}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Block>
  );
}

function Conditions({ plan }: { plan: Plan }) {
  const counts = new Map<string, number>();
  for (const c of plan.unresolvedConditions) counts.set(c, (counts.get(c) ?? 0) + 1);
  return (
    <Block title="Conditions" aside={<span className="text-xs text-muted">{plan.fullyPriced ? "fully priced" : "not fully priced"}</span>}>
      {counts.size === 0 ? (
        <p className="text-[13px] text-muted">No open conditions on this plan.</p>
      ) : (
        <ul className="space-y-1">
          {[...counts.entries()].map(([text, n]) => (
            <li key={text} className="flex gap-2 text-[13px] leading-snug text-text">
              <Glyph name="warn" className="mt-1 text-amber" />
              <span>
                {text}
                {n > 1 ? <span className="num ml-1 text-xs text-muted">×{n}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

export function ApproveBlock({ gate, onApprove, pending }: { gate: ApprovalGate; onApprove: () => void; pending: boolean }) {
  const plan = gate.plan;
  const label = pending ? "Approving…" : plan && gate.enabled ? `Approve plan r${plan.revision} · ${formatCents(plan.totals.totalCents)}` : "Approve plan";
  return (
    <div>
      <Button variant="primary" className="h-10 w-full text-[15px]" disabled={!gate.enabled} onClick={onApprove} aria-describedby="approve-reason" aria-keyshortcuts="a">
        {label}
      </Button>
      <p id="approve-reason" className="mt-1.5 text-xs leading-snug text-muted">
        {gate.reason}
        {gate.enabled ? <span className="ml-1 hidden lg:inline">Shortcut: a</span> : null}
      </p>
    </div>
  );
}

function Orders({ run, onSettle, pending }: { run: Run; onSettle: (orderId: string) => void; pending: string | null }) {
  const orders = [...run.orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id));
  return (
    <Block title="Simulated orders" aside={<span className="num text-xs text-muted">{orders.length}</span>}>
      {orders.length === 0 ? (
        <p className="text-[13px] leading-snug text-muted">No simulated orders yet. Approving a plan places them; nothing is charged for real.</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {orders.map((o) => {
            const meta = ORDER_STATUS_META[o.status] ?? ORDER_STATUS_META.simulated_placed!;
            const c = o.cancellation;
            return (
              <li key={o.id} className="py-2">
                <div className="flex items-baseline gap-2">
                  <span className={cx("min-w-0 flex-1 truncate text-sm", o.status === "cancelled" || o.status === "superseded" ? "text-muted" : "text-text")}>{o.merchantName}</span>
                  <span className="num text-sm text-text">{formatCents(o.amountCents)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Chip tone={meta.tone} glyph={meta.glyph}>
                    {meta.label}
                  </Chip>
                  <span className="font-mono">{o.id}</span>
                  <span>plan r{o.planRevision}</span>
                </div>
                {c ? (
                  <div className="mt-1.5 text-xs leading-snug text-muted">
                    <p>{c.reason}</p>
                    <p className="num mt-0.5">
                      Refund {formatCents(c.refundCents)}
                      {c.refundStatus === "settled" ? " · settled" : c.refundStatus === "pending" ? " · pending" : ""}
                      {c.retainedCents > 0 ? <span className="text-red"> · retained {formatCents(c.retainedCents)}</span> : null}
                    </p>
                    {c.refundStatus === "pending" ? (
                      <Button size="sm" variant="secondary" className="mt-1.5" disabled={pending !== null} onClick={() => onSettle(o.id)}>
                        Settle simulated refund
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

function InfeasibilityCard({ run, onRaise, pending }: { run: Run; onRaise: (cents: number) => void; pending: string | null }) {
  const inf = run.infeasibility;
  if (!inf) return null;
  const ci = inf.cheapestInvalid;
  const top = Object.entries(inf.evaluation.rejectedByReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <section className="border-b border-line px-4 py-3" aria-labelledby="infeasible-title">
      <div className="flex items-center gap-2">
        <Glyph name="cross" className="text-red" />
        <h3 id="infeasible-title" className="text-sm font-semibold text-red">
          No feasible plan
        </h3>
        <Chip tone="red" className="ml-auto">
          {inf.kind.replace(/_/g, " ")}
        </Chip>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-text">{inf.summary}</p>
      {ci ? (
        <div className="mt-2 rounded-md border border-line bg-ink/60 px-3 py-2">
          <p className="text-xs text-muted">Closest otherwise-valid package</p>
          <p className="mt-0.5 text-sm text-text">{ci.merchants.join(" + ")}</p>
          <dl className="mt-1">
            <KV label="Exposure">{formatCents(ci.totalCents)}</KV>
            <KV label="Budget">{formatCents(ci.totalCents - ci.budgetGapCents)}</KV>
            <KV label="Gap" emphasis>
              <span className="text-red">{formatCents(ci.budgetGapCents)}</span>
            </KV>
          </dl>
          <p className="mt-1 flex flex-wrap gap-1.5">
            {ci.failing.map((code) => (
              <Chip key={code} tone="red" glyph="cross">
                {REJECT_LABEL[code]}
              </Chip>
            ))}
          </p>
        </div>
      ) : null}
      <ul className="mt-2 space-y-1">
        {inf.details.map((d) => (
          <li key={d} className="flex gap-2 text-xs leading-snug text-muted">
            <Glyph name="dash" className="mt-0.5" />
            {d}
          </li>
        ))}
      </ul>
      {ci && inf.kind === "over_budget" ? (
        <div className="mt-3">
          <Button variant="primary" className="w-full" disabled={pending !== null || PHASE_META[run.phase].busy} onClick={() => onRaise(ci.totalCents)}>
            Raise budget to {formatCents(ci.totalCents)}
          </Button>
          <p className="mt-1.5 text-xs leading-snug text-muted">Re-runs clearing with the existing offers. A new plan still needs your approval.</p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted">Blocked: no supply is invented to keep the demo moving.</p>
      )}
      {top.length ? (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted hover:text-text">
            <span className="num">{inf.evaluation.candidatesChecked}</span> candidates checked · rejections by rule
          </summary>
          <table className="num mt-1.5 w-full">
            <tbody>
              {top.map(([code, n]) => (
                <tr key={code} className="border-t border-line/60">
                  <td className="py-1 text-text">{REJECT_LABEL[code as keyof typeof REJECT_LABEL] ?? code}</td>
                  <td className="py-1 text-right text-muted">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Disruption controls
// ---------------------------------------------------------------------------

const DISRUPTABLE = new Set(["simulated_confirmed", "proposed", "needs_approval", "no_feasible_plan"]);

function DisruptionControls({ run, plan, pending, onDisrupt }: { run: Run; plan: Plan | null; pending: string | null; onDisrupt: (d: DisruptionInput) => void }) {
  const id = useId();
  const allowed = DISRUPTABLE.has(run.phase) && !run.job && pending === null;
  const selections = plan?.selections ?? [];
  const cancellable = selections.filter((s) => run.availability[s.merchantId]?.available !== false);
  const delayable = selections.filter((s) => {
    const o = run.offers.find((x) => x.id === s.offerId && x.revision === s.offerRevision);
    return o && o.fulfillment.mode !== "pickup_only";
  });
  const [merchant, setMerchant] = useState("");
  const [delayOffer, setDelayOffer] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [headcount, setHeadcount] = useState(String(run.requirements?.headcount ?? 60));
  const merchantValue = cancellable.some((s) => s.merchantId === merchant) ? merchant : cancellable[0]?.merchantId ?? "";
  const delayValue = delayable.some((s) => s.offerId === delayOffer) ? delayOffer : delayable[0]?.offerId ?? "";
  const hc = Number(headcount);
  const hcValid = Number.isInteger(hc) && hc >= 1 && hc <= 5000 && hc !== run.requirements?.headcount;

  return (
    <Block title="Disruptions" aside={<span className="text-xs text-muted">simulated</span>}>
      {!DISRUPTABLE.has(run.phase) ? (
        <p className="mb-2 text-xs leading-snug text-muted">Available once a plan is proposed or approved.</p>
      ) : null}
      <div className="space-y-3">
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (merchantValue) onDisrupt({ type: "supplier_unavailable", merchantId: merchantValue });
          }}
        >
          <label htmlFor={`${id}-cancel`} className="block text-[13px] text-text">
            Supplier cancels
          </label>
          <div className="flex gap-2">
            <select id={`${id}-cancel`} className={inputClass} value={merchantValue} onChange={(e) => setMerchant(e.target.value)} disabled={!allowed || !cancellable.length}>
              {cancellable.length ? (
                cancellable.map((s) => (
                  <option key={s.merchantId} value={s.merchantId}>
                    {s.merchantName}
                  </option>
                ))
              ) : (
                <option value="">No selected supplier</option>
              )}
            </select>
            <Button type="submit" variant="danger" size="sm" className="h-[34px]" disabled={!allowed || !merchantValue}>
              Cancel
            </Button>
          </div>
        </form>
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (delayValue && minutes >= 5 && minutes <= 240) onDisrupt({ type: "delivery_delayed", offerId: delayValue, delayMinutes: minutes });
          }}
        >
          <label htmlFor={`${id}-delay`} className="block text-[13px] text-text">
            Delivery delayed
          </label>
          <div className="flex gap-2">
            <select id={`${id}-delay`} className={inputClass} value={delayValue} onChange={(e) => setDelayOffer(e.target.value)} disabled={!allowed || !delayable.length}>
              {delayable.length ? (
                delayable.map((s) => (
                  <option key={s.offerId} value={s.offerId}>
                    {s.merchantName}
                  </option>
                ))
              ) : (
                <option value="">No delivery in the plan</option>
              )}
            </select>
            <label htmlFor={`${id}-mins`} className="sr-only">
              Delay in minutes
            </label>
            <div className="relative w-24 shrink-0">
              <input
                id={`${id}-mins`}
                type="number"
                min={5}
                max={240}
                step={5}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className={cx(inputClass, "num pr-9")}
                disabled={!allowed || !delayable.length}
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">min</span>
            </div>
            <Button type="submit" variant="danger" size="sm" className="h-[34px]" disabled={!allowed || !delayValue || minutes < 5 || minutes > 240}>
              Delay
            </Button>
          </div>
        </form>
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (hcValid) onDisrupt({ type: "headcount_changed", headcount: hc });
          }}
        >
          <label htmlFor={`${id}-head`} className="block text-[13px] text-text">
            Headcount changes
          </label>
          <div className="flex gap-2">
            <input
              id={`${id}-head`}
              type="number"
              min={1}
              max={5000}
              value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
              className={cx(inputClass, "num")}
              disabled={!allowed || !run.requirements}
            />
            <Button type="submit" variant="danger" size="sm" className="h-[34px]" disabled={!allowed || !hcValid}>
              Change
            </Button>
          </div>
        </form>
      </div>
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function PlanPanel({
  run,
  gate,
  pending,
  onApprove,
  onOpenOffer,
  onDisrupt,
  onSettle,
  onBudget,
}: {
  run: Run;
  gate: ApprovalGate;
  pending: string | null;
  onApprove: () => void;
  onOpenOffer: (merchantId: string) => void;
  onDisrupt: (d: DisruptionInput) => void;
  onSettle: (orderId: string) => void;
  onBudget: (cents: number) => void;
}) {
  const live = activePlan(run);
  const cur = currentPlan(run);
  const plan = live ?? cur;
  const stale = Boolean(plan && !live);
  const statusTone = plan?.status === "approved" ? "mint" : plan?.status === "proposed" ? "amber" : "neutral";

  return (
    <div className="flex flex-col">
      <SectionHeader title="Plan" count={plan ? `r${plan.revision}${plan.basedOnRevision ? ` · repairs r${plan.basedOnRevision}` : ""}` : undefined}>
        {plan && stale ? (
          <Chip tone="amber" glyph="warn" title={`Plan r${plan.revision} is ${plan.status} but was built for an earlier request`}>
            {plan.status} · out of date
          </Chip>
        ) : plan ? (
          <Chip tone={statusTone} glyph={plan.status === "approved" ? "check" : plan.status === "proposed" ? "warn" : "dash"}>
            {plan.status}
          </Chip>
        ) : null}
      </SectionHeader>
      {run.phase === "no_feasible_plan" ? <InfeasibilityCard run={run} onRaise={onBudget} pending={pending} /> : null}
      {plan ? (
        <>
          <div className="border-b border-line px-4 py-3">
            {stale ? (
              <p className="mb-2 flex gap-2 text-xs leading-snug text-amber">
                <Glyph name="warn" className="mt-0.5" />
                Last approved plan. It was built for the previous request and no longer covers the modelled requirements; its simulated orders stay in place until a new plan is approved.
              </p>
            ) : null}
            <p className="text-[13px] leading-snug text-muted">{plan.reason}</p>
            {!stale ? (
              <div className="mt-3 hidden lg:block">
                <ApproveBlock gate={gate} onApprove={onApprove} pending={pending === "Approve"} />
              </div>
            ) : null}
          </div>
          <Selections run={run} plan={plan} onOpenOffer={onOpenOffer} />
          <Totals plan={plan} />
          <Schedule plan={plan} />
          <Coverage plan={plan} />
          <Conditions plan={plan} />
        </>
      ) : run.phase !== "no_feasible_plan" ? (
        <EmptyState title={PHASE_META[run.phase].busy ? "Plan forming" : "No plan yet"}>
          {run.phase === "draft" || run.phase === "confirming"
            ? "Confirm the requirements to open the market. Suppliers quote, two targeted negotiation rounds run, then the solver picks the best feasible package."
            : "The market is still collecting and negotiating. A plan appears here when the solver finds a feasible package."}
        </EmptyState>
      ) : null}
      <Orders run={run} onSettle={onSettle} pending={pending} />
      <DisruptionControls key={`${run.id}:${run.requestVersion}:${plan?.revision ?? 0}`} run={run} plan={plan} pending={pending} onDisrupt={onDisrupt} />
    </div>
  );
}
