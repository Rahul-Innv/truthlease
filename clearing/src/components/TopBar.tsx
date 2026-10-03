"use client";
import type { ReactNode } from "react";
import type { IntegrationStatus, Phase } from "@/lib/contracts";
import type { Connection } from "@/hooks/useRunStream";
import { PHASE_META } from "./format";
import { Button, Chip, Glyph, Kbd, cx } from "./ui";

export function PhaseChip({ phase }: { phase: Phase }) {
  const m = PHASE_META[phase];
  return (
    <Chip tone={m.tone} glyph={m.glyph} pulse={m.busy} title={`Phase: ${phase}`} className="min-w-0 shrink">
      <span className="truncate sm:hidden">{m.short}</span>
      <span className="hidden truncate sm:inline">{m.label}</span>
    </Chip>
  );
}

export function SimulationBadge({ reasoning }: { reasoning?: "local" | "live" }) {
  const reasoningLabel = reasoning === "live" ? "Live model (unverified)" : "Local rules";
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-dashed border-amber/50 px-2 text-xs font-medium text-amber">
      <Glyph name="warn" />
      Demo suppliers · {reasoningLabel} · Simulated orders
    </span>
  );
}

const CONNECTION_META: Record<Connection, { label: string; glyph: "dot" | "half" | "ring"; className: string }> = {
  live: { label: "Live", glyph: "dot", className: "text-mint" },
  connecting: { label: "Connecting", glyph: "half", className: "text-muted" },
  reconnecting: { label: "Reconnecting", glyph: "half", className: "text-amber" },
  static: { label: "Static sample", glyph: "ring", className: "text-muted" },
};

function ConnectionState({ connection }: { connection: Connection }) {
  const m = CONNECTION_META[connection];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs font-medium", m.className)} title={`Event stream: ${m.label}`}>
      <Glyph name={m.glyph} className={connection === "connecting" || connection === "reconnecting" ? "pulse" : undefined} />
      <span className="sr-only sm:not-sr-only">{m.label}</span>
    </span>
  );
}

function StatusRow({ label, value, ok, note }: { label: string; value: ReactNode; ok: boolean | null; note?: string }) {
  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted">{label}</span>
        <span className={cx("inline-flex items-center gap-1.5 text-right text-[13px]", ok === false ? "text-muted" : "text-text")}>
          {ok === null ? null : <Glyph name={ok ? "check" : "ring"} className={ok ? "text-mint" : "text-muted"} />}
          {value}
        </span>
      </div>
      {note ? <p className="mt-0.5 text-xs leading-snug text-muted">{note}</p> : null}
    </li>
  );
}

function IntegrationPopover({ status, onOpen }: { status: IntegrationStatus | null; onOpen: () => void }) {
  return (
    <>
      <button
        type="button"
        popoverTarget="integration-status"
        onClick={onOpen}
        className="inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-md border border-line px-1.5 text-xs font-medium text-text hover:bg-surface-2 sm:px-2.5"
        aria-label="Integration status"
        title="Integration status"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="text-muted sm:hidden">
          <path d="M3 11V8M7 11V5M11 11V2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="hidden sm:inline">Integrations</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="hidden text-muted sm:block">
          <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <div
        id="integration-status"
        popover="auto"
        className="top-popover w-[min(360px,calc(100vw-24px))] rounded-lg border border-line bg-surface p-0 text-text shadow-2xl shadow-black/50"
      >
        <div className="border-b border-line px-4 py-3">
          <p className="text-sm font-semibold">Integration status</p>
          <p className="text-xs text-muted">Read from /api/status. Presence checks only; no secrets are shown.</p>
        </div>
        {status ? (
          <ul className="divide-y divide-line px-4">
            <StatusRow
              label="Reasoning"
              value={status.reasoning.provider}
              ok={status.reasoning.mode === "local" ? true : status.reasoning.verified}
              note={status.reasoning.mode === "live" && !status.reasoning.verified ? "Live model configured; unverified until a successful call." : undefined}
            />
            <StatusRow label="Supply" value={status.supply} ok={null} />
            <StatusRow label="Coordination" value={status.coordination} ok={null} />
            <StatusRow label="Execution" value={status.execution} ok={null} />
            <StatusRow label="Tavily" value={status.tavily.connected ? "Connected" : "Not connected"} ok={status.tavily.connected} note={status.tavily.note} />
            <StatusRow label="ZooWork" value={status.zoowork.connected ? "Connected" : "Not connected"} ok={status.zoowork.connected} note={status.zoowork.note} />
            <StatusRow label="BAND" value={status.band.connected ? "Connected" : "Not connected"} ok={status.band.connected} note={status.band.note} />
          </ul>
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted">Status not loaded yet.</p>
        )}
        <p className="border-t border-line px-4 py-3 text-xs leading-snug text-muted">
          Offer arrival is paced for readability
          {status ? (
            <>
              {" "}
              (<span className="num">{status.paceMs}</span> ms per supplier)
            </>
          ) : null}
          . Pacing is not supplier response time; solver time is measured separately.
        </p>
      </div>
    </>
  );
}

export function TopBar({
  phase,
  connection,
  status,
  onStatusOpen,
  onReset,
  onHelp,
  resetDisabled,
}: {
  phase: Phase | null;
  connection: Connection;
  status: IntegrationStatus | null;
  onStatusOpen: () => void;
  onReset: () => void;
  onHelp: () => void;
  resetDisabled?: boolean;
}) {
  return (
    <header className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-ink px-4 py-2">
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-2.5 sm:flex-none sm:basis-auto">
        <span className="flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight text-text">
          <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
            <path d="M13 16l6-6m-6 6l6 6" stroke="#a3a79f" strokeWidth="2" strokeLinecap="round" />
            <circle cx="9" cy="16" r="3.5" fill="#ede8df" />
            <circle cx="23" cy="10" r="3.5" fill="#5eead4" />
            <circle cx="23" cy="22" r="3.5" fill="none" stroke="#a3a79f" strokeWidth="2" />
          </svg>
          Clearing
        </span>
        {phase ? <PhaseChip phase={phase} /> : null}
      </div>
      <div className="order-last w-full sm:order-none sm:w-auto">
        <SimulationBadge reasoning={status?.reasoning.mode} />
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
        <ConnectionState connection={connection} />
        <IntegrationPopover status={status} onOpen={onStatusOpen} />
        <span className="hidden sm:block">
          <Button variant="ghost" size="sm" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
            <Kbd>?</Kbd>
          </Button>
        </span>
        <Button variant="secondary" size="sm" onClick={onReset} disabled={resetDisabled} title="Reset the demo (r)">
          Reset
        </Button>
      </div>
    </header>
  );
}
