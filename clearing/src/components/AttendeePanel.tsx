"use client";
/**
 * Attendee opt-in (P1) in the Brief panel: create the public link, watch the
 * aggregate counts arrive through the run snapshot, and apply them to the
 * requirements. Applying is the organizer's act; the public link can only
 * submit answers.
 */
import { useId, useState, useSyncExternalStore } from "react";
import { useAttendeeCommands } from "@/hooks/useRunStream";
import type { Run } from "@/lib/contracts";
import { PHASE_META, clockTime, plural } from "./format";
import { Button, SectionHeader, cx } from "./ui";

const APPLY_PHASES: readonly Run["phase"][] = ["confirming", "simulated_confirmed", "proposed", "needs_approval", "no_feasible_plan"];

const noSubscribe = () => () => {};

export function AttendeePanel({ run, pending }: { run: Run; pending: string | null }) {
  const id = useId();
  const cmd = useAttendeeCommands();
  const [latest, setLatest] = useState<Run | null>(null);
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");

  // The command's own response can arrive before the stream's snapshot.
  const shown = latest && latest.id === run.id && latest.version > run.version ? latest : run;
  const req = shown.requirements;
  if (!req) return null;

  const link = shown.attendeeLink?.enabled ? shown.attendeeLink : null;
  const s = shown.attendeeSummary ?? { responses: 0, people: 0, vegetarian: 0, flexible: 0, appliedAt: null, appliedPeople: null };
  const url = link ? `${origin}/attend/${link.token}` : "";
  const busy = pending !== null || cmd.pending !== null;
  const runBusy = PHASE_META[shown.phase].busy || shown.job !== null;
  const matches = s.people === req.headcount && s.vegetarian === req.vegetarianMin;
  const hasPlan = shown.phase !== "confirming";

  let applyReason: string;
  if (s.responses === 0) applyReason = "Available after the first response.";
  else if (runBusy || !APPLY_PHASES.includes(shown.phase)) applyReason = "Wait until the market has finished working.";
  else if (matches) applyReason = `Requirements already match: ${s.people} guests, ${s.vegetarian} vegetarian.`;
  else
    applyReason = `Sets headcount to ${s.people} and vegetarian minimum to ${s.vegetarian}. This changes the request${
      hasPlan ? ": the plan is re-quoted and repaired, and any plan will need fresh approval." : "; any plan built from it will need approval."
    }`;
  const canApply = s.responses > 0 && !runBusy && APPLY_PHASES.includes(shown.phase) && !matches && !busy;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      (document.getElementById(`${id}-url`) as HTMLInputElement | null)?.select();
      setCopied("manual");
    }
  }

  return (
    <section aria-labelledby={`${id}-title`}>
      <SectionHeader id={`${id}-title`} title="Attendee opt-in" count={link ? plural(s.responses, "response") : "P1 · optional"} />
      <div className="space-y-3 px-4 py-3">
        {!link ? (
          <>
            <p className="text-[13px] leading-snug text-muted">
              Share a link where attendees choose vegetarian or flexible and how many people they answer for. No names or contact details; an answer is not an order or a payment.
            </p>
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={async () => {
                const r = await cmd.createAttendeeLink(run.id);
                if (r) setLatest(r);
              }}
            >
              {cmd.pending === "Create attendee link" ? "Creating link…" : "Create attendee link"}
            </Button>
          </>
        ) : (
          <>
            <div>
              <label htmlFor={`${id}-url`} className="mb-1 block text-xs text-muted">
                Attendee link
              </label>
              <div className="flex gap-2">
                <input
                  id={`${id}-url`}
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="num min-w-0 flex-1 rounded-md border border-line bg-ink px-2.5 py-1.5 font-mono text-xs text-text focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                />
                <Button size="sm" className="h-[30px]" onClick={() => void copy()} aria-describedby={copied ? `${id}-copied` : undefined}>
                  Copy
                </Button>
              </div>
              <p id={`${id}-copied`} role="status" className="mt-1 text-xs text-muted">
                {copied === "yes" ? "Copied to the clipboard." : copied === "manual" ? "Clipboard unavailable: the link is selected, copy it manually." : ""}
              </p>
              <p className="text-xs leading-snug text-muted">
                Anyone with this link can submit a preference. It cannot see the budget, plan or offers, and cannot approve, cancel or change anything.
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-line bg-ink/60 px-3 py-2" aria-label="Attendee counts">
              {(
                [
                  ["Responses", s.responses],
                  ["People", s.people],
                  ["Vegetarian", s.vegetarian],
                  ["Flexible", s.flexible],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-2">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="num text-[15px] font-semibold text-text">{n}</dd>
                </div>
              ))}
            </dl>
            {s.appliedAt ? (
              <p className="text-xs text-muted">
                Last applied {clockTime(s.appliedAt, shown.request.timezone)}: {plural(s.appliedPeople ?? 0, "guest")}.
              </p>
            ) : null}
            <div>
              <Button
                variant={canApply ? "primary" : "secondary"}
                className="w-full"
                disabled={!canApply}
                aria-describedby={`${id}-apply`}
                onClick={async () => {
                  const r = await cmd.applyAttendeeCounts(run.id);
                  if (r) setLatest(r);
                }}
              >
                {cmd.pending === "Apply attendee counts" ? "Applying…" : "Apply counts to requirements"}
              </Button>
              <p id={`${id}-apply`} className={cx("mt-1.5 text-xs leading-snug", canApply ? "text-amber" : "text-muted")}>
                {applyReason}
              </p>
            </div>
          </>
        )}
        {cmd.error ? (
          <p role="alert" className="flex items-start gap-2 text-xs text-red">
            <span className="min-w-0 flex-1">{cmd.error}</span>
            <button type="button" className="shrink-0 text-muted hover:text-text" onClick={cmd.clearError}>
              Dismiss
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
