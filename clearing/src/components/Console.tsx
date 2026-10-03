"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useElementHeight } from "@/hooks/useElementWidth";
import { useRunStream, type StaticSource } from "@/hooks/useRunStream";
import type { RejectCode, Run } from "@/lib/contracts";
import { BriefPanel } from "./BriefPanel";
import { approvalGate, deriveNodes } from "./derive";
import { PHASE_META, REJECT_LABEL, activePlan, formatCents } from "./format";
import { HistoryPanel } from "./HistoryPanel";
import { MarketGraph } from "./MarketGraph";
import { OfferDrawer } from "./OfferDrawer";
import { ApproveBlock, PlanPanel } from "./PlanPanel";
import { TopBar } from "./TopBar";
import { Button, Chip, Glyph, Kbd, cx } from "./ui";

function Modal({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[min(420px,calc(100vw-32px))] rounded-xl border border-line bg-surface p-0 text-text shadow-2xl shadow-black/60"
    >
      {open ? <div className="p-5">{children}</div> : null}
    </dialog>
  );
}

function announcement(run: Run): string {
  const label = PHASE_META[run.phase].label;
  const plan = activePlan(run);
  if (run.phase === "no_feasible_plan" && run.infeasibility) return `Phase: ${label}. ${run.infeasibility.summary}`;
  if (run.phase === "needs_approval" && plan) return `Phase: ${label}. Plan recovered, review changes. Total ${formatCents(plan.totals.totalCents)}.`;
  if (run.phase === "proposed" && plan) return `Phase: ${label}. Market cleared. Total ${formatCents(plan.totals.totalCents)}, ${plan.schedule.slackMinutes} minutes slack.`;
  return `Phase: ${label}.`;
}

function LoadingShell({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Glyph name="half" className="pulse text-accent" />
        {message}
      </p>
    </div>
  );
}

export function Console({ source, banner }: { source?: StaticSource; banner?: ReactNode }) {
  const stream = useRunStream(source ? { source } : {});
  const { run, events, status, connection, pending, notice, commands, refreshStatus, dismissNotice } = stream;
  const [selected, setSelected] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const nodes = useMemo(() => (run ? deriveNodes(run, events) : []), [run, events]);
  const gate = approvalGate(run, pending);
  const selectedNode = selected ? nodes.find((n) => n.merchantId === selected) ?? null : null;

  const approve = useCallback(() => {
    if (gate.enabled && gate.plan) void commands.approve(gate.plan.revision);
  }, [gate.enabled, gate.plan, commands]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "a" && gate.enabled) {
        e.preventDefault();
        approve();
      } else if (e.key === "r") {
        e.preventDefault();
        setResetOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gate.enabled, approve]);

  const plan = run ? activePlan(run) : null;
  const [barRef, barHeight] = useElementHeight<HTMLDivElement>();

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <TopBar
        phase={run?.phase ?? null}
        connection={connection}
        status={status}
        onStatusOpen={() => void refreshStatus()}
        onReset={() => setResetOpen(true)}
        onHelp={() => setHelpOpen(true)}
        resetDisabled={pending !== null}
      />
      {banner}
      <div aria-live="polite" className="sr-only">
        {run ? announcement(run) : ""}
      </div>

      {!run ? (
        <LoadingShell message={connection === "reconnecting" ? "Reconnecting to the server…" : "Loading the current run…"} />
      ) : (
        <main
          className="grid flex-1 grid-cols-1 pb-[var(--bar-h,9rem)] lg:min-h-0 lg:grid-cols-[272px_minmax(0,1fr)_320px] lg:pb-0 xl:grid-cols-[320px_minmax(0,1fr)_380px]"
          style={barHeight ? ({ "--bar-h": `${barHeight}px` } as CSSProperties) : undefined}
        >
          <aside aria-label="Brief and requirements" className="scroll-thin order-1 border-b border-line bg-surface lg:order-none lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <BriefPanel
              run={run}
              pending={pending}
              onSubmit={(r) => void commands.submitRequest(r)}
              onConfirm={(edits) => void commands.confirm(edits)}
              onBudget={(c) => void commands.updateBudget(c)}
            />
          </aside>
          <div className="order-3 flex min-w-0 flex-col lg:order-none lg:min-h-0">
            <div className="scroll-thin lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              <MarketGraph run={run} nodes={nodes} onOpenOffer={setSelected} />
            </div>
            <div className="scroll-thin border-t border-line bg-surface lg:h-[clamp(230px,32vh,340px)] lg:shrink-0 lg:overflow-y-auto">
              <HistoryPanel events={events} timeZone={run.request.timezone} />
            </div>
          </div>
          <aside aria-label="Plan and approval" className="scroll-thin order-2 border-b border-line bg-surface lg:order-none lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-l">
            <PlanPanel
              run={run}
              gate={gate}
              pending={pending}
              onApprove={approve}
              onOpenOffer={setSelected}
              onDisrupt={(d) => void commands.disrupt(d)}
              onSettle={(id) => void commands.settleRefund(id)}
              onBudget={(c) => void commands.updateBudget(c)}
            />
          </aside>
        </main>
      )}

      {run ? (
        <div ref={barRef} className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgba(0,0,0,0.45)] lg:hidden">
          <div className="mb-2 flex items-center gap-2 text-[13px]">
            <span className="text-muted">{plan ? `Plan r${plan.revision}` : PHASE_META[run.phase].label}</span>
            {plan ? <span className="num font-semibold text-text">{formatCents(plan.totals.totalCents)}</span> : null}
            {plan ? <span className="num ml-auto text-xs text-muted">{plan.schedule.slackMinutes} min slack · {formatCents(plan.budget.remainingCents)} left</span> : null}
          </div>
          {run.phase === "no_feasible_plan" && run.infeasibility?.kind === "over_budget" && run.infeasibility.cheapestInvalid ? (
            <div>
              <Button
                variant="primary"
                className="h-10 w-full text-[15px]"
                disabled={pending !== null}
                onClick={() => void commands.updateBudget(run.infeasibility!.cheapestInvalid!.totalCents)}
              >
                Raise budget to {formatCents(run.infeasibility.cheapestInvalid.totalCents)}
              </Button>
              <p className="mt-1.5 text-xs leading-snug text-muted">No feasible plan: the closest package is {formatCents(run.infeasibility.cheapestInvalid.budgetGapCents)} over budget.</p>
            </div>
          ) : (
            <ApproveBlock gate={gate} onApprove={approve} pending={pending === "Approve"} />
          )}
        </div>
      ) : null}

      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={cx(
            "fixed right-4 z-40 w-[min(380px,calc(100vw-32px))] rounded-lg border bg-surface px-4 py-3 shadow-2xl shadow-black/50",
            "bottom-40 lg:bottom-4",
            notice.tone === "error" ? "border-red/50" : "border-line",
          )}
        >
          <div className="flex items-start gap-2">
            <Glyph name={notice.tone === "error" ? "cross" : "dot"} className={cx("mt-1", notice.tone === "error" ? "text-red" : "text-accent")} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text">{notice.title}</p>
              {notice.message ? <p className="mt-0.5 text-[13px] leading-snug text-muted">{notice.message}</p> : null}
              {notice.codes?.length ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {notice.codes.map((c) => (
                    <li key={c}>
                      <Chip tone="red" glyph="cross" title={c}>
                        {REJECT_LABEL[c as RejectCode] ?? c}
                      </Chip>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <Button variant="ghost" size="sm" onClick={dismissNotice} aria-label="Dismiss message">
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {run ? <OfferDrawer run={run} node={selectedNode} onClose={() => setSelected(null)} /> : null}

      <Modal open={resetOpen} onClose={() => setResetOpen(false)} labelledBy="reset-title">
        <h2 id="reset-title" className="text-base font-semibold">
          Reset the demo?
        </h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted">
          Deletes this run, its events and its simulated orders, then recreates the editable preset request. Nothing real is affected.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setResetOpen(false)} autoFocus>
            Keep run
          </Button>
          <Button
            variant="danger"
            disabled={pending !== null}
            onClick={() => {
              setResetOpen(false);
              setSelected(null);
              void commands.reset();
            }}
          >
            Reset run
          </Button>
        </div>
      </Modal>

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} labelledBy="help-title">
        <h2 id="help-title" className="text-base font-semibold">
          Keyboard shortcuts
        </h2>
        <dl className="mt-3 space-y-2 text-[13px]">
          {[
            ["a", "Approve the proposed plan (when enabled)"],
            ["r", "Reset the demo (asks first)"],
            ["?", "Show this help"],
            ["Tab", "Move between controls and market nodes"],
            ["Enter", "Open the focused offer"],
            ["Esc", "Close a drawer or dialog"],
          ].map(([k, d]) => (
            <div key={k} className="flex items-center gap-3">
              <dt className="w-12 shrink-0">
                <Kbd>{k}</Kbd>
              </dt>
              <dd className="text-text">{d}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={() => setHelpOpen(false)} autoFocus>
            Close
          </Button>
        </div>
      </Modal>
    </div>
  );
}
