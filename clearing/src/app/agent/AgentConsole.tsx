"use client";

import { useRef, useState } from "react";
import { formatCents } from "@/lib/money";

const MAX_TEXT = 2_000;

type Tone = "ok" | "warn" | "error";

interface Exchange {
  id: number;
  method: "GET" | "POST";
  path: string;
  /** The JSON body as sent, pretty-printed; null for GET. */
  requestBody: string | null;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  /** The response body as received, pretty-printed when it is JSON. */
  responseBody: string;
  summary: string;
  tone: Tone;
  at: string;
  ms: number;
}

type Obj = Record<string, unknown>;
const isRecord = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function newKey(prefix: string): string {
  let id: string;
  try {
    id = crypto.randomUUID();
  } catch {
    id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
  return `${prefix}-${id}`.slice(0, 80);
}

/** One human-readable line above the raw JSON. The JSON stays the source of truth. */
function summarize(path: string, status: number | null, data: unknown): { text: string; tone: Tone } {
  if (status === null) return { text: "No response: the request did not complete.", tone: "error" };
  if (!isRecord(data)) return { text: `HTTP ${status}`, tone: status < 400 ? "ok" : "error" };
  if (status >= 400) {
    const err = isRecord(data.error) ? data.error : {};
    const code = str(err.code) ?? "error";
    const message = str(err.message);
    return { text: `HTTP ${status} · ${code}${message ? ` · ${message}` : ""}`, tone: "error" };
  }
  const phase = str(data.phase) ?? "unknown";
  if (path === "/api/agent/request") {
    const req = isRecord(data.requirements) ? data.requirements : {};
    const missing = Array.isArray(req.missing) ? req.missing.filter((m): m is string => typeof m === "string") : [];
    const next = str(data.nextAction) ?? "?";
    return { text: `Phase ${phase} · next action: ${next}${missing.length ? ` · missing: ${missing.join(", ")}` : " · nothing missing"}`, tone: missing.length ? "warn" : "ok" };
  }
  if (path === "/api/agent/confirm") return { text: `Phase ${phase} · market opening; read the plan to follow progress`, tone: "ok" };
  if (path === "/api/agent/plan") {
    const plan = isRecord(data.plan) ? data.plan : null;
    if (plan) {
      const total = num(plan.totalCents);
      const slack = num(plan.slackMinutes);
      const names = Array.isArray(plan.selections) ? plan.selections.map((s) => (isRecord(s) ? str(s.merchant) : null)).filter((n): n is string => n !== null) : [];
      const parts = [`Phase ${phase}`, `plan r${num(plan.revision) ?? "?"}`];
      if (total !== null) parts.push(`total ${formatCents(total)}`);
      if (slack !== null) parts.push(`${slack} min slack`);
      if (names.length) parts.push(names.join(", "));
      return { text: parts.join(" · "), tone: "ok" };
    }
    const inf = isRecord(data.infeasibility) ? data.infeasibility : null;
    if (inf) {
      const gap = num(inf.budgetGapCents);
      return { text: `Phase ${phase} · no feasible plan: ${str(inf.summary) ?? "see JSON"}${gap !== null && gap > 0 ? ` · budget gap ${formatCents(gap)}` : ""}`, tone: "warn" };
    }
    return { text: `Phase ${phase} · no plan yet`, tone: "ok" };
  }
  return { text: `HTTP ${status} · phase ${phase}`, tone: "ok" };
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const TONE_CLASS: Record<Tone, string> = {
  ok: "text-mint",
  warn: "text-amber",
  error: "text-red",
};
const TONE_GLYPH: Record<Tone, string> = { ok: "✓", warn: "△", error: "✕" };
const STATUS_CHIP: Record<Tone, string> = {
  ok: "border-mint/35 bg-mint/10 text-mint",
  warn: "border-amber/35 bg-amber/10 text-amber",
  error: "border-red/40 bg-red/10 text-red",
};

const BTN = "inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 sm:h-9";
const BTN_PRIMARY = `${BTN} border-mint bg-mint text-ink hover:bg-mint/90`;
const BTN_SECONDARY = `${BTN} border-line bg-surface-2 text-text hover:border-muted/60`;

/** Evidence block: same treatment as the console's history evidence (dark panel, header bar, monospace, scroll). */
function Evidence({ label, meta, body, tall }: { label: string; meta?: string; body: string; tall?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-ink">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5 text-xs text-muted">
        <span className="font-medium">{label}</span>
        {meta ? <span className="num truncate font-mono">{meta}</span> : null}
      </div>
      <pre className={`scroll-thin ${tall ? "max-h-96" : "max-h-56"} overflow-auto overscroll-contain whitespace-pre px-3 py-2 font-mono text-xs leading-relaxed text-text`}>{body}</pre>
    </div>
  );
}

export function AgentConsole({ presetText }: { presetText: string }) {
  const [text, setText] = useState(presetText);
  const [busy, setBusy] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const nextId = useRef(1);

  async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    if (busy) return;
    setBusy(`${method} ${path}`);
    const started = performance.now();
    const id = nextId.current++;
    const requestBody = body ? JSON.stringify(body, null, 2) : null;
    let entry: Exchange;
    try {
      const res = await fetch(path, {
        method,
        cache: "no-store",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const raw = await res.text();
      let data: unknown = null;
      try {
        data = JSON.parse(raw);
      } catch {
        // not JSON; shown as received
      }
      const s = summarize(path, res.status, data);
      entry = { id, method, path, requestBody, status: res.status, responseBody: pretty(raw), summary: s.text, tone: s.tone, at: new Date().toLocaleTimeString(), ms: Math.round(performance.now() - started) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      entry = { id, method, path, requestBody, status: null, responseBody: message, summary: summarize(path, null, null).text, tone: "error", at: new Date().toLocaleTimeString(), ms: Math.round(performance.now() - started) };
    }
    setExchanges((prev) => [entry, ...prev]);
    setBusy(null);
  }

  const sendRequest = () => call("POST", "/api/agent/request", { text, idempotencyKey: newKey("agent-ui-request") });
  const confirm = () => call("POST", "/api/agent/confirm", { idempotencyKey: newKey("agent-ui-confirm") });
  const readPlan = () => call("GET", "/api/agent/plan");

  const tooLong = text.length > MAX_TEXT;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
      <section aria-label="Compose a request" className="flex min-w-0 flex-col rounded-lg border border-line bg-surface lg:sticky lg:top-6">
        <div className="flex min-h-9 items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-1.5">
          <span className="rounded border border-line bg-ink px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent">POST</span>
          <span className="truncate font-mono text-xs text-text">/api/agent/request</span>
        </div>
        <div className="flex flex-col gap-2 p-4">
          <label htmlFor="agent-text" className="text-[13px] font-semibold text-text">
            Request text
          </label>
          <textarea
            id="agent-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            spellCheck={false}
            aria-describedby="agent-text-hint"
            className="w-full resize-y rounded-md border border-line bg-ink px-3 py-2 text-sm leading-relaxed text-text placeholder:text-muted focus-visible:border-accent"
          />
          <div className="flex items-start justify-between gap-3 text-xs leading-snug text-muted">
            <span id="agent-text-hint">Sent as the JSON field “text”. Date, timezone and clock are left to the defaults.</span>
            <span className={tooLong ? "num shrink-0 text-red" : "num shrink-0"}>
              {text.length}/{MAX_TEXT}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={sendRequest} disabled={busy !== null} className={BTN_PRIMARY}>
              Send request
            </button>
            <button type="button" onClick={confirm} disabled={busy !== null} className={BTN_SECONDARY}>
              Confirm
            </button>
            <button type="button" onClick={readPlan} disabled={busy !== null} className={BTN_SECONDARY}>
              Read plan
            </button>
          </div>
          <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" aria-label="Call order">
            <li>
              <span className="num font-mono">1</span> request
            </li>
            <li aria-hidden className="text-muted/60">
              →
            </li>
            <li>
              <span className="num font-mono">2</span> confirm
            </li>
            <li aria-hidden className="text-muted/60">
              →
            </li>
            <li>
              <span className="num font-mono">3</span> read plan until proposed
            </li>
          </ol>
          <p role="status" className="text-xs text-amber empty:hidden">
            {busy ? `Sending ${busy}…` : ""}
          </p>
        </div>
      </section>

      <section aria-labelledby="transcript-heading" data-testid="transcript" className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex min-h-9 items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-1.5">
          <h2 id="transcript-heading" className="text-[13px] font-semibold text-text">
            Transcript
          </h2>
          <span className="num text-xs text-muted">{exchanges.length ? `${exchanges.length} · newest first` : "empty"}</span>
          <span className="ml-auto text-xs text-muted">raw JSON, both directions</span>
        </div>
        {exchanges.length === 0 ? (
          <div className="px-4 py-6">
            <p className="text-sm font-medium text-text">Nothing sent yet.</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              Use Send request, then Confirm, then Read plan until the phase is proposed. Every call and reply appears here as raw JSON.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {exchanges.map((x) => (
              <li key={x.id} data-testid="exchange" className="flex min-w-0 flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={`inline-flex h-6 items-center rounded-md border px-2 font-mono text-xs font-semibold ${STATUS_CHIP[x.tone]}`}>
                    <span aria-hidden className="mr-1.5">
                      {TONE_GLYPH[x.tone]}
                    </span>
                    {x.status ?? "ERR"}
                  </span>
                  <span className="min-w-0 break-all font-mono text-xs font-semibold text-text">
                    {x.method} {x.path}
                  </span>
                  <span className="num ml-auto font-mono text-xs text-muted">
                    {x.ms} ms · {x.at}
                  </span>
                </div>
                <p className={`text-[13px] leading-snug ${TONE_CLASS[x.tone]}`}>{x.summary}</p>
                {x.requestBody ? <Evidence label="Request body" meta={`${x.method} ${x.path}`} body={x.requestBody} /> : null}
                <Evidence label="Response body" meta={x.status === null ? "no response" : `HTTP ${x.status}`} body={x.responseBody} tall />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
