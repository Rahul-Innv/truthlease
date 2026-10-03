"use client";
import { useState, type ReactNode } from "react";
import type { RunEvent } from "@/lib/contracts";
import { clockTime } from "./format";
import { Button, EmptyState, SectionHeader, cx } from "./ui";

type Family = "red" | "mint" | "amber" | "accent";
const FAMILY_TEXT: Record<Family, string> = { red: "text-red", mint: "text-mint", amber: "text-amber", accent: "text-accent" };
const FAMILY_DOT: Record<Family, string> = { red: "bg-red", mint: "bg-mint", amber: "bg-amber", accent: "bg-accent/70" };

function family(type: string): Family {
  if (type === "plan.infeasible" || type === "job.failed" || type === "offer.withdrawn" || type === "order.cancelled" || type === "disruption.injected") return "red";
  if (type === "market.cleared" || type === "plan.approved" || type.startsWith("order.simulated") || type === "refund.settled") return "mint";
  if (type === "plan.proposed" || type === "plan.repaired" || type === "offer.revised" || type === "offer.requoted" || type === "refund.pending" || type === "model.fallback") return "amber";
  return "accent";
}

/** Restrained JSON highlighting: keys in accent, values in text, null/booleans muted. */
function JsonView({ value }: { value: unknown }) {
  const lines: ReactNode[] = [];
  let i = 0;
  const walk = (v: unknown, indent: number, key: string | null, last: boolean) => {
    const pad = "  ".repeat(indent);
    const k = key !== null ? (
      <>
        <span className="text-accent">&quot;{key}&quot;</span>
        <span className="text-muted">: </span>
      </>
    ) : null;
    const comma = last ? "" : ",";
    if (v !== null && typeof v === "object") {
      const entries = Array.isArray(v) ? v.map((x, idx) => [String(idx), x] as const) : Object.entries(v as Record<string, unknown>);
      const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
      if (entries.length === 0) {
        lines.push(
          <div key={i++}>
            {pad}
            {k}
            <span className="text-muted">
              {open}
              {close}
              {comma}
            </span>
          </div>,
        );
        return;
      }
      lines.push(
        <div key={i++}>
          {pad}
          {k}
          <span className="text-muted">{open}</span>
        </div>,
      );
      entries.forEach(([ek, ev], idx) => walk(ev, indent + 1, Array.isArray(v) ? null : ek, idx === entries.length - 1));
      lines.push(
        <div key={i++}>
          {pad}
          <span className="text-muted">
            {close}
            {comma}
          </span>
        </div>,
      );
      return;
    }
    const text = typeof v === "string" ? JSON.stringify(v) : String(v);
    const cls = v === null || typeof v === "boolean" ? "italic text-muted" : typeof v === "number" ? "text-text" : "text-text/90";
    lines.push(
      <div key={i++}>
        {pad}
        {k}
        <span className={cls}>{text}</span>
        <span className="text-muted">{comma}</span>
      </div>,
    );
  };
  walk(value, 0, null, true);
  return <>{lines}</>;
}

function EventRow({ ev, timeZone, open, onToggle }: { ev: RunEvent; timeZone: string; open: boolean; onToggle: () => void }) {
  const panelId = `evt-${ev.seq}`;
  return (
    <li className="relative pl-8">
      <span className={cx("absolute left-[13px] top-[13px] h-2 w-2 rounded-full ring-4 ring-surface", FAMILY_DOT[family(ev.type)])} aria-hidden />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-3 text-left hover:bg-surface-2/60 @2xl:flex-row @2xl:items-baseline @2xl:gap-3"
      >
        <span className="flex min-w-0 shrink-0 items-baseline gap-3">
          <span className="num w-8 shrink-0 font-mono text-xs text-muted">#{ev.seq}</span>
          <span className="num w-[5.5rem] shrink-0 text-xs text-muted">{clockTime(ev.at, timeZone)}</span>
          <span className={cx("min-w-0 truncate font-mono text-xs @2xl:w-44", FAMILY_TEXT[family(ev.type)])} title={ev.type}>
            {ev.type}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted @2xl:hidden">{open ? "Hide" : "Evidence"}</span>
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-snug text-text">{ev.summary}</span>
        <span className="hidden shrink-0 text-xs text-muted @2xl:inline">{open ? "Hide evidence" : "Evidence"}</span>
      </button>
      {open ? (
        <div id={panelId} className="mb-2 mr-3 rounded-md border border-line bg-ink">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
            <span className="font-mono">{ev.id}</span>
            {ev.causeId ? <span className="font-mono">cause {ev.causeId}</span> : null}
          </div>
          <pre className="scroll-thin max-h-56 overflow-auto overscroll-contain px-3 py-2 font-mono text-xs leading-relaxed">
            <JsonView value={ev.payload} />
          </pre>
        </div>
      ) : null}
    </li>
  );
}

export function HistoryPanel({ events, timeZone }: { events: RunEvent[]; timeZone: string }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const newestFirst = [...events].sort((a, b) => b.seq - a.seq);
  const LIMIT = 40;
  const shown = showAll ? newestFirst : newestFirst.slice(0, LIMIT);
  return (
    <section aria-labelledby="history-title" className="@container flex flex-col">
      <div className="sticky top-0 z-10 bg-surface">
        <SectionHeader id="history-title" title="History" count={`${events.length} events · newest first`}>
          {open.size ? (
            <Button size="sm" variant="ghost" onClick={() => setOpen(new Set())}>
              Collapse all
            </Button>
          ) : null}
        </SectionHeader>
      </div>
      {events.length === 0 ? (
        <EmptyState title="No events yet">Every state change is stored as an event before the UI shows it. Events stream in here as the run progresses.</EmptyState>
      ) : (
        <>
          <ol className="relative py-1">
            <span className="absolute bottom-3 left-4 top-3 w-px bg-line" aria-hidden />
            {shown.map((ev) => (
              <EventRow
                key={ev.seq}
                ev={ev}
                timeZone={timeZone}
                open={open.has(ev.seq)}
                onToggle={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(ev.seq)) n.delete(ev.seq);
                    else n.add(ev.seq);
                    return n;
                  })
                }
              />
            ))}
          </ol>
          {newestFirst.length > LIMIT ? (
            <div className="px-4 pb-3">
              <Button size="sm" variant="secondary" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show latest 40" : `Show all ${newestFirst.length} events`}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
