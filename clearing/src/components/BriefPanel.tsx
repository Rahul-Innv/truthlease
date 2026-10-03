"use client";
import { useId, useState } from "react";
import type { RequestInput, RequirementField, Requirements, Run } from "@/lib/contracts";
import type { ConfirmEdits } from "@/hooks/useRunStream";
import { parseDollarsToCents } from "@/lib/money";
import { addMinutes } from "@/lib/time";
import { FIELD_LABEL, FIELD_STATUS_META, PHASE_META, formatCents, formatLocal, longDate } from "./format";
import { Button, Chip, EmptyState, Glyph, SectionHeader, cx } from "./ui";

const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

const inputClass =
  "w-full rounded-md border border-line bg-ink px-2.5 py-1.5 text-sm text-text placeholder:text-muted/80 hover:border-muted/50 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";

// ---------------------------------------------------------------------------
// Request editor
// ---------------------------------------------------------------------------

function RequestEditor({ run, disabled, pending, onSubmit }: { run: Run; disabled: boolean; pending: boolean; onSubmit: (r: RequestInput) => void }) {
  const [text, setText] = useState(run.request.text);
  const [eventDate, setEventDate] = useState(run.request.eventDate);
  const [timezone, setTimezone] = useState(run.request.timezone);
  const [nowLocal, setNowLocal] = useState(run.request.nowLocal);
  const id = useId();
  const zones = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];
  const dirty = text !== run.request.text || eventDate !== run.request.eventDate || timezone !== run.request.timezone || nowLocal !== run.request.nowLocal;
  const hasPlan = run.plans.length > 0;
  const tooLong = text.length > 2000;

  return (
    <form
      className="space-y-3 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || tooLong || !text.trim()) return;
        onSubmit({ text: text.trim(), eventDate, timezone, nowLocal, ...(run.request.venueName ? { venueName: run.request.venueName } : {}) });
      }}
    >
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label htmlFor={`${id}-text`} className="text-[13px] font-medium text-text">
            What does the event need?
          </label>
          <span className={cx("num text-xs", tooLong ? "text-red" : "text-muted")}>{text.length.toLocaleString("en-US")} / 2,000</span>
        </div>
        <textarea
          id={`${id}-text`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          className={cx(inputClass, "resize-y leading-relaxed")}
          disabled={disabled}
          spellCheck
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${id}-date`} className="mb-1 block text-xs text-muted">
            Event date
          </label>
          <input id={`${id}-date`} type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className={inputClass} disabled={disabled} required />
        </div>
        <div>
          <label htmlFor={`${id}-clock`} className="mb-1 block text-xs text-muted">
            Simulated clock
          </label>
          <input id={`${id}-clock`} type="time" step={60} value={nowLocal} onChange={(e) => setNowLocal(e.target.value)} className={inputClass} disabled={disabled} required />
        </div>
        <div className="col-span-2">
          <label htmlFor={`${id}-tz`} className="mb-1 block text-xs text-muted">
            Timezone
          </label>
          <select id={`${id}-tz`} value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputClass} disabled={disabled}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs leading-snug text-muted">The simulated clock is the &ldquo;now&rdquo; on the event date used for lead times. It is not your real clock.</p>
      <div className="flex items-center gap-2">
        <Button type="submit" variant={run.phase === "draft" ? "primary" : "secondary"} disabled={disabled || tooLong || !text.trim()}>
          {pending ? "Interpreting…" : run.phase === "draft" ? "Interpret request" : "Re-interpret request"}
        </Button>
        {dirty && hasPlan ? <span className="text-xs text-amber">Re-interpreting supersedes the current plan.</span> : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Requirements card
// ---------------------------------------------------------------------------

type EditableField = "headcount" | "vegetarianMin" | "readyBy" | "budget";
const EDITABLE: EditableField[] = ["headcount", "vegetarianMin", "readyBy", "budget"];

function editKey(f: EditableField): keyof ConfirmEdits {
  return f === "readyBy" ? "readyByLocal" : f === "budget" ? "budgetCents" : f;
}

function currentValue(req: Requirements, edits: ConfirmEdits, f: EditableField): number | string {
  switch (f) {
    case "headcount":
      return edits.headcount ?? req.headcount;
    case "vegetarianMin":
      return edits.vegetarianMin ?? req.vegetarianMin;
    case "readyBy":
      return edits.readyByLocal ?? req.readyByLocal;
    case "budget":
      return edits.budgetCents ?? req.budgetCents;
  }
}

function displayValue(f: EditableField, v: number | string): string {
  if (f === "headcount") return `${v} guests`;
  if (f === "vegetarianMin") return `${v} vegetarian`;
  if (f === "readyBy") return formatLocal(String(v));
  return formatCents(Number(v));
}

function draftFor(f: EditableField, v: number | string): string {
  if (f === "budget") return (Number(v) / 100).toFixed(2);
  return String(v);
}

function parseDraft(f: EditableField, draft: string, req: Requirements, edits: ConfirmEdits): { ok: true; value: number | string } | { ok: false; error: string } {
  if (f === "readyBy") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft)) return { ok: false, error: "Use a time like 18:30." };
    return { ok: true, value: draft };
  }
  if (f === "budget") {
    const cents = parseDollarsToCents(draft);
    if (cents === null || cents <= 0) return { ok: false, error: "Enter a dollar amount." };
    if (cents > 50_000_000) return { ok: false, error: "Budget is above the demo limit." };
    return { ok: true, value: cents };
  }
  const n = Number(draft);
  if (!Number.isInteger(n)) return { ok: false, error: "Enter a whole number." };
  if (f === "headcount" && (n < 1 || n > 5000)) return { ok: false, error: "Between 1 and 5,000." };
  if (f === "vegetarianMin") {
    const head = edits.headcount ?? req.headcount;
    if (n < 0 || n > head) return { ok: false, error: `Between 0 and ${head}.` };
  }
  return { ok: true, value: n };
}

function EditableRow({
  field,
  req,
  edits,
  status,
  canEdit,
  lockedHint,
  applyLabel,
  onSave,
}: {
  field: EditableField;
  req: Requirements;
  edits: ConfirmEdits;
  status: "confirmed" | "assumed" | "missing";
  canEdit: boolean;
  lockedHint?: string;
  applyLabel: string;
  onSave: (value: number | string) => void;
}) {
  const edited = edits[editKey(field)] !== undefined;
  const missing = status === "missing" && !edited;
  const [open, setOpen] = useState(missing && canEdit);
  const value = currentValue(req, edits, field);
  const [draft, setDraft] = useState(missing ? "" : draftFor(field, value));
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const meta = FIELD_STATUS_META[status];

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-muted">{FIELD_LABEL[field]}</span>
        {edited ? (
          <Chip tone="accent" glyph="dot" className="h-5 px-1.5">
            Edited
          </Chip>
        ) : (
          <Chip tone={meta.tone} glyph={meta.glyph} className="h-5 px-1.5">
            {meta.label}
          </Chip>
        )}
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className={cx("num min-w-0 flex-1 text-[15px] font-medium", missing ? "text-red" : "text-text")}>{missing ? "Not stated" : displayValue(field, value)}</span>
        {canEdit && !open ? (
          <button
            type="button"
            className="rounded px-1 text-xs font-medium text-accent hover:underline"
            onClick={() => {
              setDraft(missing ? "" : draftFor(field, value));
              setError(null);
              setOpen(true);
            }}
            aria-label={`Edit ${FIELD_LABEL[field]}`}
          >
            {missing ? "Add" : "Edit"}
          </button>
        ) : null}
      </div>
      {field === "readyBy" && !missing ? (
        <p className="mt-0.5 text-xs text-muted">
          Arrivals by {formatLocal(addMinutes(String(value), -req.setupBufferMinutes))} ({req.setupBufferMinutes} min setup buffer)
        </p>
      ) : null}
      {!canEdit && lockedHint ? <p className="mt-0.5 text-xs text-muted">{lockedHint}</p> : null}
      {open ? (
        <form
          className="mt-2 flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const r = parseDraft(field, draft.trim(), req, edits);
            if (!r.ok) {
              setError(r.error);
              return;
            }
            onSave(r.value);
            setOpen(false);
          }}
        >
          <label htmlFor={`${id}-in`} className="sr-only">
            {FIELD_LABEL[field]}
          </label>
          <div className="relative min-w-0 flex-1">
            {field === "budget" ? <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted">$</span> : null}
            <input
              id={`${id}-in`}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              type={field === "readyBy" ? "time" : "text"}
              inputMode={field === "budget" ? "decimal" : field === "readyBy" ? undefined : "numeric"}
              className={cx(inputClass, "num", field === "budget" && "pl-6")}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-err` : undefined}
              placeholder={field === "headcount" ? "60" : field === "vegetarianMin" ? "20" : field === "budget" ? "1000.00" : "18:30"}
            />
          </div>
          <Button type="submit" size="sm" variant="primary" className="h-[34px]">
            {applyLabel}
          </Button>
          {status !== "missing" || edited ? (
            <Button size="sm" variant="ghost" className="h-[34px]" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          ) : null}
          {error ? (
            <p id={`${id}-err`} className="w-full text-xs text-red">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

function StaticRow({ label, value, status }: { label: string; value: string; status: "confirmed" | "assumed" | "missing" }) {
  const meta = FIELD_STATUS_META[status];
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-muted">{label}</span>
        <Chip tone={meta.tone} glyph={meta.glyph} className="h-5 px-1.5">
          {meta.label}
        </Chip>
      </div>
      <p className="mt-0.5 text-sm leading-snug text-text">{value}</p>
    </li>
  );
}

const RANK = { missing: 2, assumed: 1, confirmed: 0 } as const;
function worst(...xs: ("confirmed" | "assumed" | "missing")[]): "confirmed" | "assumed" | "missing" {
  return xs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "confirmed");
}

function RequirementsCard({
  run,
  req,
  pending,
  onConfirm,
  onBudget,
}: {
  run: Run;
  req: Requirements;
  pending: string | null;
  onConfirm: (edits: ConfirmEdits) => void;
  onBudget: (cents: number) => void;
}) {
  const [edits, setEdits] = useState<ConfirmEdits>({});
  const confirming = run.phase === "confirming";
  const busy = PHASE_META[run.phase].busy || run.job !== null;
  const budgetEditable = !confirming && !busy;
  const editedFields = new Set<RequirementField>(
    EDITABLE.filter((f) => edits[editKey(f)] !== undefined),
  );
  const stillMissing = req.missing.filter((f) => !editedFields.has(f));
  const status = (f: RequirementField) => req.fieldStatus[f] ?? "confirmed";

  let confirmReason = "";
  if (!confirming) confirmReason = run.phase === "draft" ? "Interpret the request first." : "Requirements are confirmed for this request.";
  else if (stillMissing.length) confirmReason = `Fill ${stillMissing.length === 1 ? "the missing field" : `${stillMissing.length} missing fields`}: ${stillMissing.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")}.`;
  else if (pending) confirmReason = "Waiting for the server…";
  const canConfirm = confirming && stillMissing.length === 0 && !pending;

  const save = (f: EditableField) => (v: number | string) => {
    if (f === "budget" && budgetEditable) {
      onBudget(Number(v));
      return;
    }
    setEdits((e) => ({ ...e, [editKey(f)]: v }));
  };

  return (
    <div>
      <ul className="divide-y divide-line/70 px-4">
        {EDITABLE.map((f) => (
          <EditableRow
            key={f}
            field={f}
            req={req}
            edits={edits}
            status={status(f)}
            canEdit={confirming || (f === "budget" && budgetEditable)}
            applyLabel={f === "budget" && budgetEditable ? "Apply budget" : "Save"}
            lockedHint={
              confirming ? undefined : f === "headcount" && run.phase !== "draft" ? "After confirmation, change headcount from Disruptions." : undefined
            }
            onSave={save(f)}
          />
        ))}
        <StaticRow
          label="Items"
          value={
            [req.items.drinks ? "Drinks" : null, req.items.plates ? "Plates" : null, req.items.utensils ? "Utensils" : null].filter(Boolean).join(" · ") ||
            "No drinks, plates or utensils"
          }
          status={worst(status("drinks"), status("plates"), status("utensils"))}
        />
        <StaticRow label={FIELD_LABEL.venue} value={req.venue.name} status={status("venue")} />
        <StaticRow label="Date and timezone" value={`${longDate(req.eventDate)} · ${req.timezone}`} status={worst(status("eventDate"), status("timezone"))} />
        <StaticRow label={FIELD_LABEL.objective} value={req.objective} status={status("objective")} />
      </ul>
      {req.preferences.length || req.assumptions.length ? (
        <div className="space-y-1.5 border-t border-line px-4 py-3">
          {req.preferences.map((p) => (
            <p key={p} className="flex gap-2 text-[13px] text-text">
              <Glyph name="dot" className="mt-1 text-muted" />
              {p}
            </p>
          ))}
          {req.assumptions.map((a) => (
            <p key={`${a.field}-${a.note}`} className="flex gap-2 text-[13px] leading-snug text-muted">
              <Glyph name="warn" className="mt-1 text-amber" />
              <span>
                <span className="text-amber">Assumed · </span>
                {a.note}
              </span>
            </p>
          ))}
        </div>
      ) : null}
      <div className="border-t border-line px-4 py-3">
        <Button variant="primary" className="w-full" disabled={!canConfirm} onClick={() => onConfirm(edits)} aria-describedby="confirm-reason">
          {pending === "Confirm requirements" ? "Opening market…" : "Confirm & open market"}
        </Button>
        <p id="confirm-reason" className={cx("mt-1.5 text-xs leading-snug", stillMissing.length && confirming ? "text-red" : "text-muted")}>
          {canConfirm ? "Suppliers in the demo catalog will quote against these requirements." : confirmReason}
        </p>
      </div>
    </div>
  );
}

export function BriefPanel({
  run,
  pending,
  onSubmit,
  onConfirm,
  onBudget,
}: {
  run: Run;
  pending: string | null;
  onSubmit: (r: RequestInput) => void;
  onConfirm: (edits: ConfirmEdits) => void;
  onBudget: (cents: number) => void;
}) {
  const busy = PHASE_META[run.phase].busy || run.job !== null;
  const req = run.requirements;
  return (
    <div className="flex flex-col">
      <SectionHeader title="Brief" count={`request v${run.requestVersion}`} />
      <RequestEditor
        key={`editor:${run.id}:${run.requestVersion}`}
        run={run}
        disabled={busy || pending !== null}
        pending={pending === "Submit request"}
        onSubmit={onSubmit}
      />
      <SectionHeader
        title="Requirements"
        count={req ? `${req.missing.length ? `${req.missing.length} missing · ` : ""}${req.interpretedBy === "local" ? "local rules" : "live model"}` : undefined}
      />
      {req ? (
        <RequirementsCard key={`req:${run.id}:${run.requestVersion}`} run={run} req={req} pending={pending} onConfirm={onConfirm} onBudget={onBudget} />
      ) : (
        <EmptyState title="No requirements yet">Interpret the request to extract headcount, dietary needs, timing and budget. Each field is marked confirmed, assumed or missing.</EmptyState>
      )}
    </div>
  );
}
