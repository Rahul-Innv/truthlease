"use client";
import type { CapabilityGroup, Plan, Run } from "@/lib/contracts";
import { useElementWidth, useMediaQuery } from "@/hooks/useElementWidth";
import { addMinutes } from "@/lib/time";
import { NODE_STATE_META, metricsFor, type MarketNode, type NodeState } from "./derive";
import { GROUPS, GROUP_LABEL, activePlan, currentPlan, formatCents, formatLocal, offerTimeText, plural, type Glyph as GlyphName } from "./format";
import { Glyph, SectionHeader, cx } from "./ui";

// ---------------------------------------------------------------------------
// Node appearance per state: border style, glyph and label all differ.
// ---------------------------------------------------------------------------

const STATE_STYLE: Record<NodeState, { box: string; label: string; glyph: GlyphName; name: string; edge: { stroke: string; width: number; dash?: string; opacity: number } }> = {
  selected: { box: "border-mint bg-mint/[0.08]", label: "text-mint", glyph: "check", name: "text-text", edge: { stroke: "var(--color-mint)", width: 1.5, opacity: 0.85 } },
  replacement: { box: "border-mint border-dashed bg-mint/[0.05]", label: "text-mint", glyph: "swap", name: "text-text", edge: { stroke: "var(--color-mint)", width: 1.5, dash: "5 3", opacity: 0.85 } },
  candidate: { box: "border-line bg-surface hover:border-muted/60", label: "text-accent", glyph: "ring", name: "text-text", edge: { stroke: "#56627c", width: 1, opacity: 0.9 } },
  rejected: { box: "border-line bg-surface/70 hover:border-muted/60", label: "text-muted", glyph: "cross", name: "text-text/85", edge: { stroke: "#3a4762", width: 1, opacity: 0.9 } },
  withdrawn: { box: "border-red/55 border-dashed bg-red/[0.05]", label: "text-red", glyph: "cross", name: "text-muted line-through decoration-red/70", edge: { stroke: "var(--color-red)", width: 1, dash: "3 3", opacity: 0.45 } },
  superseded: { box: "border-muted/40 border-dashed bg-transparent", label: "text-muted", glyph: "dash", name: "text-muted", edge: { stroke: "var(--color-muted)", width: 1, dash: "4 4", opacity: 0.35 } },
  awaiting: { box: "border-line border-dotted bg-transparent", label: "text-muted", glyph: "half", name: "text-muted", edge: { stroke: "#3a4762", width: 1, dash: "1 4", opacity: 0.9 } },
  no_quote: { box: "border-line border-dotted bg-transparent", label: "text-muted", glyph: "ring", name: "text-muted", edge: { stroke: "#3a4762", width: 1, dash: "1 4", opacity: 0.7 } },
};

const OFFER_H = 54;
const TAG_LINE = 16;
const OFFER_GAP = 8;
const GROUP_GAP = 18;
const GROUP_H_WIDE = 66;
const EVENT_H = 96;
const PAD = 16;
const MIN_LINK = 28;
const CHAR_W = 6.6; // approx. width of a 12px character in the UI stack

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  /** Canvas width; larger than the viewport width when the graph scrolls horizontally. */
  width: number;
  height: number;
  twoCol: boolean;
  event: Box;
  groups: Record<CapabilityGroup, Box>;
  offers: (Box & { node: MarketNode })[];
}

/** Third line of an offer node: the state tag or the supplier's skip reason. */
function tagText(node: MarketNode): string | undefined {
  const parts = [node.assembly, node.tag ?? node.skippedReason].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function offerHeight(node: MarketNode, w: number): number {
  const t = tagText(node);
  if (!t) return OFFER_H;
  const avail = Math.max(80, w - 24 - 20);
  const lines = Math.min(2, Math.max(1, Math.ceil((t.length * CHAR_W) / avail)));
  return OFFER_H + TAG_LINE * lines;
}

function layout(nodes: MarketNode[], viewportW: number, twoCol: boolean): Layout {
  let width = viewportW;
  let eventW = 0;
  let groupW: number;
  let offerW: number;
  let xGroup: number;
  if (twoCol) {
    groupW = 118;
    offerW = Math.max(170, width - PAD * 2 - groupW - MIN_LINK);
    xGroup = PAD;
  } else {
    const roomy = viewportW >= 700;
    eventW = roomy ? 156 : 124;
    groupW = roomy ? 172 : 136;
    const minOffer = 210;
    width = Math.max(viewportW, PAD * 2 + eventW + groupW + MIN_LINK * 2 + minOffer);
    offerW = Math.round(Math.min(300, Math.max(minOffer, width * 0.42), width - PAD * 2 - eventW - groupW - MIN_LINK * 2));
    const xOfferTmp = width - PAD - offerW;
    xGroup = Math.round((PAD + eventW + xOfferTmp) / 2 - groupW / 2);
  }
  const xOffer = width - PAD - offerW;
  const groupH = twoCol ? 84 : GROUP_H_WIDE;
  let y = PAD;
  const offers: Layout["offers"] = [];
  const groups = {} as Layout["groups"];
  GROUPS.forEach((g, gi) => {
    if (gi > 0) y += GROUP_GAP;
    const inGroup = nodes.filter((n) => n.group === g);
    const start = y;
    if (inGroup.length === 0) y += OFFER_H + OFFER_GAP;
    for (const n of inGroup) {
      const h = offerHeight(n, offerW);
      offers.push({ node: n, x: xOffer, y, w: offerW, h });
      y += h + OFFER_GAP;
    }
    const end = y - OFFER_GAP;
    groups[g] = { x: xGroup, y: Math.round(Math.max(start, (start + end) / 2 - groupH / 2)), w: groupW, h: groupH };
  });
  const height = Math.max(y - OFFER_GAP, groups.delivery.y + groupH) + PAD;
  const mid = (groups.meals.y + groups.delivery.y + groupH) / 2;
  return { width, height, twoCol, event: { x: PAD, y: Math.round(mid - EVENT_H / 2), w: eventW, h: EVENT_H }, groups, offers };
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, (x2 - x1) * 0.5);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

function groupStatus(g: CapabilityGroup, run: Run, plan: Plan | null): { text: string; ok: boolean | null } {
  const req = run.requirements;
  if (!req) return { text: "awaiting brief", ok: null };
  if (!plan && req.missing.includes("headcount") && g !== "delivery") return { text: "headcount missing", ok: null };
  if (g === "meals") {
    const need = `${req.headcount} · ≥${req.vegetarianMin} veg`;
    if (!plan) return { text: need, ok: null };
    const veg = plan.coverage.meal_vegetarian?.supplied ?? 0;
    const all = veg + (plan.coverage.meal_standard?.supplied ?? 0);
    return { text: `${all}/${req.headcount} · ${veg} veg`, ok: veg >= req.vegetarianMin && all >= req.headcount };
  }
  if (g === "drinks_consumables") {
    const items = [req.items.drinks && "drinks", req.items.plates && "plates", req.items.utensils && "utensils"].filter(Boolean) as string[];
    if (!items.length) return { text: "none requested", ok: null };
    if (!plan) return { text: `${req.headcount} ${items.join(" · ")}`, ok: null };
    const short = (["drink_serving", "plate", "utensil_set"] as const).some((k) => (plan.coverage[k]?.supplied ?? 0) < (plan.coverage[k]?.required ?? 0));
    return { text: short ? "short" : `${req.headcount} each`, ok: !short };
  }
  const latest = formatLocal(addMinutes(req.readyByLocal, -req.setupBufferMinutes));
  if (!plan) return { text: `at venue by ${latest}`, ok: null };
  return { text: `last ${formatLocal(plan.schedule.lastArrivalLocal)} · ${plan.schedule.slackMinutes} min slack`, ok: plan.schedule.slackMinutes >= 0 };
}

// ---------------------------------------------------------------------------
// Signature banner
// ---------------------------------------------------------------------------

const HONESTY = "Feasible proposed solution for the modelled requirements · simulated orders";

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="whitespace-nowrap @max-xl:flex @max-xl:items-baseline @max-xl:gap-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cx("num text-[15px] font-semibold @xl:text-base", tone ?? "text-text")}>{value}</dd>
    </div>
  );
}

export function SignatureBanner({ run }: { run: Run }) {
  const plan = currentPlan(run);
  const phase = run.phase;
  if (phase === "no_feasible_plan" && run.infeasibility) {
    const inf = run.infeasibility;
    const ci = inf.cheapestInvalid;
    return (
      <div role="status" className="@container mx-4 mt-3 rounded-lg border border-red/45 bg-red/[0.06] px-4 py-3">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
          <div className="min-w-0 flex-[1_1_22rem]">
            <p className="flex items-center gap-2 text-lg font-semibold tracking-[0.06em] text-red @xl:text-xl">
              <Glyph name="cross" className="h-4 w-4 shrink-0" />
              <span>NO FEASIBLE PLAN</span>
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-text">{inf.summary}</p>
            <p className="mt-0.5 text-xs text-muted">Nothing was relaxed automatically · simulated orders unchanged</p>
          </div>
          {ci ? (
            <dl className="flex flex-wrap gap-x-6 gap-y-1">
              <Stat label="Budget gap" value={formatCents(ci.budgetGapCents)} tone="text-red" />
              <Stat label="Closest package" value={formatCents(ci.totalCents)} />
            </dl>
          ) : null}
        </div>
      </div>
    );
  }
  if (!plan || plan.requestVersion !== run.requestVersion) return null;
  const repaired = Boolean(plan.basedOnRevision);
  const review = phase === "needs_approval" || (phase === "proposed" && repaired);
  const cleared = phase === "proposed" || phase === "approved" || phase === "simulated_confirmed" || phase === "needs_approval";
  if (!cleared) return null;
  const approved = phase === "approved" || phase === "simulated_confirmed";
  const title = review ? "PLAN RECOVERED — REVIEW CHANGES" : repaired ? "PLAN RECOVERED" : "MARKET CLEARED";
  const tone = review ? "amber" : "mint";
  return (
    <div role="status" className={cx("@container mx-4 mt-3 rounded-lg border px-4 py-3", tone === "amber" ? "border-amber/45 bg-amber/[0.06]" : "border-mint/40 bg-mint/[0.06]")}>
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
        <div className="min-w-0 flex-[1_1_22rem]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className={cx("flex items-center gap-2 font-semibold", title.length > 20 ? "text-base tracking-[0.03em] @xl:text-lg" : "text-lg tracking-[0.06em] @xl:text-xl", tone === "amber" ? "text-amber" : "text-mint")}>
              <Glyph name={review ? "warn" : "check"} className="h-4 w-4 shrink-0" />
              <span>{title}</span>
            </p>
            <span className="rounded-md border border-line bg-ink/50 px-2 py-0.5 text-xs font-medium text-text">
              {approved ? `r${plan.revision} approved · simulated orders confirmed` : review ? `r${plan.revision} needs approval` : `r${plan.revision} awaits approval`}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">{HONESTY}</p>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          <Stat label="Total" value={formatCents(plan.totals.totalCents)} />
          <Stat label="Remaining" value={formatCents(plan.budget.remainingCents)} tone={plan.budget.remainingCents < 0 ? "text-red" : undefined} />
          <Stat label="Slack" value={`${plan.schedule.slackMinutes} min`} />
        </dl>
      </div>
    </div>
  );
}

function Progress({ run }: { run: Run }) {
  const busy = ["collecting", "negotiating", "clearing", "disrupted", "repairing"].includes(run.phase);
  if (!busy) return null;
  const responded = new Set(run.offers.filter((o) => o.requestVersion === run.requestVersion).map((o) => o.merchantId)).size;
  const label =
    run.phase === "collecting"
      ? `Collecting offers · ${responded} of ${run.merchants.length} suppliers quoted`
      : run.phase === "negotiating"
        ? `Negotiating · ${run.negotiation.length} targeted asks so far`
        : run.phase === "clearing"
          ? "Clearing · evaluating candidate packages"
          : run.phase === "disrupted"
            ? "Disruption recorded · invalidating affected selections"
            : "Repairing · preserving what still works";
  return (
    <div role="status" className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.05] px-4 py-2.5 text-[13px] text-text">
      <Glyph name="half" className="pulse text-accent" />
      {label}
      <span className="ml-auto text-xs text-muted">Offer arrival is paced for readability</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

const CLOSEST_STYLE = {
  box: "border-amber/60 border-dashed bg-amber/[0.05] hover:border-amber",
  label: "text-amber",
  glyph: "warn" as GlyphName,
  name: "text-text",
  edge: { stroke: "var(--color-amber)", width: 1, dash: "4 3", opacity: 0.7 },
};

function styleFor(node: MarketNode) {
  return node.closest ? CLOSEST_STYLE : STATE_STYLE[node.state];
}

function OfferNodeButton({ node, x, y, w, h, onOpen }: { node: MarketNode; x: number; y: number; w: number; h: number; onOpen: (merchantId: string) => void }) {
  const s = styleFor(node);
  const meta = NODE_STATE_META[node.state];
  const o = node.offer;
  const tag = tagText(node);
  const aria = `${node.merchantName}. ${meta.label}${tag ? `, ${tag}` : ""}.${o ? ` ${formatCents(o.totalCents)}, ${offerTimeText(o)}, request version ${o.requestVersion}, revision ${o.revision}.` : ""} Open offer details.`;
  return (
    <button
      type="button"
      data-merchant={node.merchantId}
      onClick={() => onOpen(node.merchantId)}
      aria-label={aria}
      className={cx("absolute flex flex-col justify-center rounded-lg border px-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent", s.box)}
      style={{ left: x, top: y, width: w, height: h }}
    >
      <span className="flex w-full items-center gap-2">
        <Glyph name={s.glyph} className={s.label} />
        <span className={cx("min-w-0 flex-1 truncate text-sm font-medium", s.name)}>{node.merchantName}</span>
        {o ? <span className={cx("num text-sm", node.state === "withdrawn" || node.state === "superseded" ? "text-muted" : "text-text")}>{formatCents(o.totalCents)}</span> : null}
      </span>
      <span className="mt-1 flex w-full items-center gap-1.5 pl-5 text-xs">
        <span className={cx("shrink-0 font-medium", s.label)}>{meta.label}</span>
        {o ? (
          <>
            <span className="text-muted" aria-hidden>
              ·
            </span>
            <span className="min-w-0 flex-1 truncate text-muted">{offerTimeText(o)}</span>
            <span className="shrink-0 font-mono text-xs text-muted">
              v{o.requestVersion} · r{o.revision}
            </span>
          </>
        ) : null}
      </span>
      {tag ? (
        <span className="mt-0.5 line-clamp-2 w-full pl-5 text-xs leading-4 text-muted" title={tag}>
          {tag}
        </span>
      ) : null}
    </button>
  );
}

export function MarketGraph({ run, nodes, onOpenOffer }: { run: Run; nodes: MarketNode[]; onOpenOffer: (merchantId: string) => void }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(720);
  const isLg = useMediaQuery("(min-width: 1024px)");
  const viewportW = Math.max(300, width);
  const L = layout(nodes, viewportW, !isLg && viewportW < 560);
  const plan = activePlan(run);
  const m = metricsFor(run);
  const req = run.requirements;
  const present = (Object.keys(STATE_STYLE) as NodeState[]).filter((s) => nodes.some((n) => n.state === s));
  const revisions = run.offers.length;

  return (
    <section aria-labelledby="market-title" className="flex flex-col">
      <SectionHeader id="market-title" title="Market" count={`${plural(run.merchants.length, "supplier")} · ${plural(revisions, "offer revision")}`} />
      <dl className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line px-4 py-2 text-xs">
        {[
          ["Candidates checked", m.candidatesChecked],
          ["Feasible", m.feasibleCandidates],
          ["Solver", m.solverMs === null ? null : `${m.solverMs} ms`],
          ["Changed selections", m.changedSelections === null ? (plan && !plan.basedOnRevision ? "none · fresh plan" : null) : m.changedSelections],
        ].map(([label, value]) => (
          <div key={String(label)} className="flex items-baseline gap-1.5">
            <dt className="text-muted">{label}</dt>
            <dd className="num font-medium text-text">{value === null || value === undefined ? "—" : String(value)}</dd>
          </div>
        ))}
      </dl>
      <div className="hidden lg:block">
        <SignatureBanner run={run} />
      </div>
      <Progress run={run} />
      {L.twoCol && req ? (
        <p className="mx-4 mt-3 text-[13px] text-text">
          <span className="font-medium">{req.objective}</span>
          <span className="text-muted">
            {" "}
            · {req.headcount} guests · ready {formatLocal(req.readyByLocal)}
          </span>
        </p>
      ) : null}
      <div ref={ref} className="scroll-thin mt-1 overflow-x-auto overflow-y-hidden">
      <div className="relative" style={{ width: L.width, height: L.height }}>
        <svg className="pointer-events-none absolute inset-0" width={L.width} height={L.height} aria-hidden>
          {!L.twoCol
            ? GROUPS.map((g) => {
                const gp = L.groups[g];
                const st = groupStatus(g, run, plan);
                return (
                  <path
                    key={`e-${g}`}
                    d={curve(L.event.x + L.event.w, L.event.y + L.event.h / 2, gp.x, gp.y + gp.h / 2)}
                    fill="none"
                    stroke={st.ok ? "var(--color-mint)" : "#56627c"}
                    strokeOpacity={st.ok ? 0.6 : 0.9}
                    strokeWidth={1}
                  />
                );
              })
            : null}
          {L.offers.flatMap(({ node, x, y, h }) =>
            node.covers.map((g) => {
              const gp = L.groups[g];
              const e = styleFor(node).edge;
              return (
                <path
                  key={`o-${node.merchantId}-${g}`}
                  d={curve(gp.x + gp.w, gp.y + gp.h / 2, x, y + h / 2)}
                  fill="none"
                  stroke={e.stroke}
                  strokeOpacity={e.opacity}
                  strokeWidth={e.width}
                  strokeDasharray={e.dash}
                />
              );
            }),
          )}
        </svg>
        {!L.twoCol ? (
          <div className="absolute flex flex-col justify-center rounded-lg border border-text/30 bg-surface-2 px-3" style={{ left: L.event.x, top: L.event.y, width: L.event.w, height: L.event.h }}>
            <span className="text-xs text-muted">Event</span>
            <span className="truncate text-sm font-semibold text-text">{req?.objective ?? "Draft request"}</span>
            {req ? (
              <span className="num text-xs leading-snug text-muted">
                {req.missing.includes("headcount") ? <span className="text-red">headcount missing</span> : `${req.headcount} guests`}
                <br />
                {req.missing.includes("readyBy") ? <span className="text-red">ready-by missing</span> : `ready ${formatLocal(req.readyByLocal)}`}
                <br />
                {req.missing.includes("budget") ? <span className="text-red">budget missing</span> : `${formatCents(req.budgetCents)} budget`}
              </span>
            ) : (
              <span className="text-xs text-muted">awaiting brief</span>
            )}
          </div>
        ) : null}
        {GROUPS.map((g) => {
          const gp = L.groups[g];
          const st = groupStatus(g, run, plan);
          return (
            <div
              key={g}
              className={cx("absolute flex flex-col justify-center rounded-lg border bg-surface px-3", st.ok === true ? "border-mint/50" : st.ok === false ? "border-red/50" : "border-line")}
              style={{ left: gp.x, top: gp.y, width: gp.w, height: gp.h }}
            >
              <span className="line-clamp-2 text-[13px] font-medium leading-tight text-text">{GROUP_LABEL[g]}</span>
              <span className={cx("num flex items-start gap-1 text-xs leading-snug", st.ok === true ? "text-mint" : st.ok === false ? "text-red" : "text-muted")}>
                {st.ok !== null ? <Glyph name={st.ok ? "check" : "cross"} className="mt-[3px]" /> : null}
                <span className="line-clamp-2">{st.text}</span>
              </span>
            </div>
          );
        })}
        {L.offers.map(({ node, x, y, w, h }) => (
          <OfferNodeButton key={node.merchantId} node={node} x={x} y={y} w={w} h={h} onOpen={onOpenOffer} />
        ))}
      </div>
      </div>
      {L.width > viewportW + 1 ? <p className="px-4 pt-1 text-xs text-muted">Scroll sideways to see every supplier.</p> : null}
      {present.length ? (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 pt-1 text-xs" aria-label="Node states">
          {present.map((s) => (
            <li key={s} className="flex items-center gap-1.5" title={NODE_STATE_META[s].description}>
              <Glyph name={STATE_STYLE[s].glyph} className={STATE_STYLE[s].label} />
              <span className="text-muted">{NODE_STATE_META[s].label}</span>
            </li>
          ))}
          {nodes.some((n) => n.closest) ? (
            <li className="flex items-center gap-1.5" title="Cheapest otherwise-valid package; fails only on budget">
              <Glyph name="warn" className="text-amber" />
              <span className="text-muted">Closest package (over budget)</span>
            </li>
          ) : null}
          <li className="ml-auto text-muted">Optimal among evaluated candidates only</li>
        </ul>
      ) : null}
    </section>
  );
}
