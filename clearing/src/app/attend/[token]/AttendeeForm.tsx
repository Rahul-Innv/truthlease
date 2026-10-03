"use client";
/**
 * Attendee opt-in form: one anonymous answer per browser (a random id kept in
 * localStorage so the same person can update it). Submit-only: nothing here
 * can read or change the organizer's budget, plan, offers or approvals.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { z } from "zod";
import { Glyph, cx } from "@/components/ui";
import { longDate } from "@/components/format";
import { ATTENDEE_DISCLAIMER, AttendeePublicView } from "@/lib/attendee";
import { AttendeePreference, type AttendeePreference as Preference } from "@/lib/contracts";
import { formatLocal } from "@/lib/time";

const MIN_PARTY = 1;
const MAX_PARTY = 6;

const OPTIONS: { value: Preference; label: string; description: string }[] = [
  { value: "vegetarian", label: "Vegetarian", description: "No meat or fish." },
  { value: "flexible", label: "Flexible", description: "Any meal works, including vegetarian." },
];

// ---------------------------------------------------------------------------
// Per-browser answer record (respondent id + last answer). localStorage can be
// unavailable (private mode, blocked storage), so an in-memory copy keeps the
// same id for the rest of this visit.
// ---------------------------------------------------------------------------

const StoredAnswer = z.object({
  respondentId: z.string().min(8).max(80),
  answer: z.object({ preference: AttendeePreference, partySize: z.number().int().min(MIN_PARTY).max(MAX_PARTY) }).optional(),
});
type StoredAnswer = z.infer<typeof StoredAnswer>;

const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function readStored(key: string): string | null {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    /* storage unavailable: fall back to this visit's copy */
  }
  return memory.get(key) ?? null;
}

function writeStored(key: string, record: StoredAnswer): void {
  const raw = JSON.stringify(record);
  memory.set(key, raw);
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    /* storage unavailable: the in-memory copy still prevents double counting during this visit */
  }
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function parseStored(raw: string | null): StoredAnswer | null {
  if (!raw) return null;
  try {
    const r = StoredAnswer.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function newRespondentId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // randomUUID needs a secure context; getRandomValues does not (e.g. a phone on a LAN address).
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------

export function AttendeeForm({ token, initial }: { token: string; initial: AttendeePublicView }) {
  const id = useId();
  const storageKey = `clearing.attend.${token}`;
  const raw = useSyncExternalStore(subscribe, () => readStored(storageKey), () => null);
  const record = useMemo(() => parseStored(raw), [raw]);

  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [preference, setPreference] = useState<Preference | null>(null);
  const [partySize, setPartySize] = useState(MIN_PARTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (savedTick > 0) confirmRef.current?.focus();
  }, [savedTick]);

  const answered = record?.answer;
  const showForm = view.enabled && (!answered || editing);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!preference) {
      setError("Choose Vegetarian or Flexible first.");
      return;
    }
    setBusy(true);
    setError(null);
    // Keep the id before sending, so a retry after a dropped response updates the same answer.
    let respondentId = record?.respondentId;
    if (!respondentId) {
      respondentId = newRespondentId();
      writeStored(storageKey, { respondentId });
    }
    try {
      const res = await fetch(`/api/attend/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ respondentId, preference, partySize }),
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const message = (data as { error?: { message?: string } } | null)?.error?.message;
        if (res.status === 404) {
          setView((v) => ({ ...v, enabled: false }));
          setError("This link is no longer accepting answers.");
        } else {
          setError(message ?? `Could not save your answer (HTTP ${res.status}).`);
        }
        return;
      }
      const parsed = AttendeePublicView.safeParse(data);
      if (parsed.success) setView(parsed.data);
      writeStored(storageKey, { respondentId, answer: { preference, partySize } });
      setEditing(false);
      setSavedTick((t) => t + 1);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const s = view.summary;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-10 pt-6">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">Clearing · meal preference</p>
      <h1 className="mt-1 text-[22px] font-semibold leading-tight text-text">{view.objective}</h1>

      <dl className="mt-3 space-y-1.5 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-muted">When</dt>
          <dd className="num text-text">
            {longDate(view.eventDate)}
            <span className="block text-[13px] text-muted">
              {view.readyByLocal ? `Food ready by ${formatLocal(view.readyByLocal)} · ` : ""}
              {view.timezone}
            </span>
          </dd>
        </div>
        {view.venueName ? (
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted">Where</dt>
            <dd className="text-text">{view.venueName}</dd>
          </div>
        ) : null}
      </dl>

      <p className="mt-4 flex gap-2 rounded-lg border border-amber/35 bg-amber/10 px-3 py-2.5 text-[13px] leading-snug text-text">
        <Glyph name="warn" className="mt-0.5 text-amber" />
        <span>{ATTENDEE_DISCLAIMER}</span>
      </p>

      {!view.enabled ? (
        <section className="mt-6 rounded-xl border border-line bg-surface px-4 py-4" role="status">
          <p className="text-[15px] font-medium text-text">This link is closed.</p>
          <p className="mt-1 text-[13px] text-muted">The organizer is not collecting answers here any more.</p>
        </section>
      ) : showForm ? (
        <form className="mt-6 space-y-6" onSubmit={submit} noValidate>
          <fieldset>
            <legend className="text-[15px] font-medium text-text">What would you like to eat?</legend>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {OPTIONS.map((o) => {
                const checked = preference === o.value;
                return (
                  <label
                    key={o.value}
                    className={cx(
                      "relative flex min-h-32 cursor-pointer flex-col gap-2 rounded-xl border p-4 transition-colors",
                      "border-line bg-surface hover:border-muted/60 active:bg-surface-2",
                      "has-[:checked]:border-mint has-[:checked]:bg-mint/10 has-[:checked]:ring-1 has-[:checked]:ring-mint",
                      "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-ink",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${id}-preference`}
                      value={o.value}
                      checked={checked}
                      onChange={() => {
                        setPreference(o.value);
                        setError(null);
                      }}
                      aria-label={o.label}
                      aria-describedby={`${id}-${o.value}-desc`}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className={cx(
                        "flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors",
                        checked ? "border-mint bg-mint text-ink" : "border-muted/70 text-transparent",
                      )}
                    >
                      <Glyph name="check" />
                    </span>
                    <span className="text-lg font-semibold leading-tight text-text">{o.label}</span>
                    <span id={`${id}-${o.value}-desc`} className="text-[13px] leading-snug text-muted">
                      {o.description}
                    </span>
                    <span aria-hidden="true" className={cx("mt-auto text-xs font-semibold uppercase tracking-[0.08em]", checked ? "text-mint" : "text-muted/70")}>
                      {checked ? "Selected" : "Tap to choose"}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div role="group" aria-labelledby={`${id}-party`}>
            <p id={`${id}-party`} className="text-[15px] font-medium text-text">
              How many people is this for?
            </p>
            <p className="mt-0.5 text-[13px] text-muted">You plus anyone you are answering for, up to {MAX_PARTY}.</p>
            <div className="mt-3 flex items-center gap-4">
              <StepButton label="Fewer people" glyph="−" disabled={partySize <= MIN_PARTY} onClick={() => setPartySize((n) => Math.max(MIN_PARTY, n - 1))} />
              <output className="num w-12 text-center text-[28px] font-semibold text-text" aria-live="polite" aria-label={`Party size ${partySize}`}>
                {partySize}
              </output>
              <StepButton label="More people" glyph="+" disabled={partySize >= MAX_PARTY} onClick={() => setPartySize((n) => Math.min(MAX_PARTY, n + 1))} />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-[13px] text-red">
              {error}
            </p>
          ) : null}

          <div className="space-y-2">
            <button
              type="submit"
              disabled={busy}
              className="h-12 w-full rounded-xl border border-mint bg-mint text-base font-semibold text-ink transition-colors hover:bg-mint/90 disabled:cursor-wait disabled:opacity-70"
            >
              {busy ? "Saving…" : answered ? "Update my answer" : "Submit"}
            </button>
            {answered ? (
              <button type="button" className="h-10 w-full rounded-xl text-sm text-muted hover:text-text" onClick={() => setEditing(false)}>
                Keep my previous answer
              </button>
            ) : null}
          </div>
        </form>
      ) : answered ? (
        <section ref={confirmRef} tabIndex={-1} role="status" className="mt-6 overflow-hidden rounded-xl border border-mint/40 bg-mint/10 focus-visible:outline-none">
          <div className="flex items-start gap-3 px-4 pb-3 pt-4">
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mint text-ink">
              <Glyph name="check" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[17px] font-semibold leading-tight text-text">Thanks, your answer is saved.</p>
              <p className="mt-1 text-[13px] text-muted">You can change it from this device.</p>
            </div>
          </div>
          <div className="border-t border-mint/25 bg-ink/40 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted">Your answer</p>
            <p className="num mt-0.5 text-lg font-semibold text-text">
              {answered.preference === "vegetarian" ? "Vegetarian" : "Flexible"} · {plural(answered.partySize, "person", "people")}
            </p>
            <button
              type="button"
              className="mt-3 h-11 w-full rounded-lg border border-line bg-surface-2 px-4 text-sm font-medium text-text hover:border-muted/60"
              onClick={() => {
                setPreference(answered.preference);
                setPartySize(answered.partySize);
                setError(null);
                setEditing(true);
              }}
            >
              Change my answer
            </button>
          </div>
        </section>
      ) : null}

      <p className="num mt-auto pt-8 text-xs text-muted">
        So far: {plural(s.responses, "answer")} · {plural(s.people, "person", "people")} ({s.vegetarian} vegetarian, {s.flexible} flexible). No names or contact details are collected.
      </p>
    </main>
  );
}

function StepButton({ label, glyph, disabled, onClick }: { label: string; glyph: string; disabled: boolean; onClick: () => void }) {
  // aria-disabled keeps the button focusable at the bounds, so keyboard focus is not lost.
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={cx(
        "flex h-12 w-12 items-center justify-center rounded-xl border text-2xl font-semibold leading-none transition-colors",
        disabled ? "cursor-not-allowed border-line text-muted/60" : "border-line bg-surface-2 text-text hover:border-muted/60",
      )}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
