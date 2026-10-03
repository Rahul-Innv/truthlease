"use client";
/**
 * Live run state for the console.
 *
 * 1. GET /api/runs/current for the snapshot (+ integration status).
 * 2. EventSource on /api/runs/current/events?after=<lastSeq>: `run.snapshot`
 *    replaces the run, `run.event` appends to the history (deduped by seq).
 * 3. Reconnects with exponential backoff, resuming from the last seen seq.
 * 4. Commands POST with a fresh idempotency key and merge the returned run.
 *
 * Snapshots and events are validated against the shared contracts; anything
 * that fails validation is dropped and reported, never rendered.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IntegrationStatus,
  Run,
  RunEvent,
  type DisruptionInput,
  type IntegrationStatus as IntegrationStatusT,
  type RequestInput,
  type Run as RunT,
  type RunEvent as RunEventT,
} from "@/lib/contracts";

export type Connection = "connecting" | "live" | "reconnecting" | "static";

export interface Notice {
  id: number;
  tone: "error" | "info";
  title: string;
  message?: string;
  codes?: string[];
}

export type ConfirmEdits = Partial<{
  headcount: number;
  vegetarianMin: number;
  readyByLocal: string;
  budgetCents: number;
  items: { drinks: boolean; plates: boolean; utensils: boolean };
}>;

export interface StaticSource {
  run: RunT;
  events: RunEventT[];
  status: IntegrationStatusT;
}

export interface RunCommands {
  submitRequest(input: RequestInput): Promise<boolean>;
  confirm(edits?: ConfirmEdits): Promise<boolean>;
  approve(planRevision: number): Promise<boolean>;
  disrupt(disruption: DisruptionInput): Promise<boolean>;
  settleRefund(orderId: string): Promise<boolean>;
  updateBudget(budgetCents: number): Promise<boolean>;
  reset(): Promise<boolean>;
}

export interface RunStream {
  run: RunT | null;
  events: RunEventT[];
  status: IntegrationStatusT | null;
  connection: Connection;
  /** Name of the command in flight, if any. */
  pending: string | null;
  notice: Notice | null;
  dismissNotice(): void;
  refreshStatus(): Promise<IntegrationStatusT | null>;
  commands: RunCommands;
  isStatic: boolean;
}

const MAX_BACKOFF_MS = 8_000;
const SNAPSHOT_CATCHUP_MS = 300;

function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function rejectCodesFrom(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { rejects?: unknown; error?: { details?: unknown } };
  const raw = Array.isArray(b.rejects)
    ? b.rejects
    : b.error?.details && typeof b.error.details === "object" && Array.isArray((b.error.details as { rejects?: unknown }).rejects)
      ? ((b.error.details as { rejects: unknown[] }).rejects)
      : undefined;
  if (!raw) return undefined;
  const codes = raw
    .map((r) => (typeof r === "string" ? r : r && typeof r === "object" && "code" in r ? String((r as { code: unknown }).code) : null))
    .filter((c): c is string => Boolean(c));
  return codes.length ? codes : undefined;
}

export function useRunStream(opts: { source?: StaticSource } = {}): RunStream {
  const source = opts.source;
  const isStatic = Boolean(source);
  const [run, setRun] = useState<RunT | null>(source?.run ?? null);
  const [events, setEvents] = useState<RunEventT[]>(source?.events ?? []);
  const [status, setStatus] = useState<IntegrationStatusT | null>(source?.status ?? null);
  const [connection, setConnection] = useState<Connection>(isStatic ? "static" : "connecting");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [streamKey, setStreamKey] = useState(0);

  const runRef = useRef<RunT | null>(run);
  const lastSeqRef = useRef<number>(events.reduce((m, e) => Math.max(m, e.seq), 0));
  const catchupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeId = useRef(0);

  const showNotice = useCallback((n: Omit<Notice, "id">) => {
    noticeId.current += 1;
    setNotice({ ...n, id: noticeId.current });
  }, []);

  const applySnapshot = useCallback((raw: unknown) => {
    const candidate = raw && typeof raw === "object" && "run" in raw ? (raw as { run: unknown }).run : raw;
    const parsed = Run.safeParse(candidate);
    if (!parsed.success) {
      console.warn("Clearing: dropped a run snapshot that failed contract validation", parsed.error.issues.slice(0, 5));
      const first = parsed.error.issues[0];
      showNotice({
        tone: "error",
        title: "Ignored an invalid run snapshot",
        message: `The server sent a run that does not match the shared contract${first ? ` (${first.path.join(".")}: ${first.message})` : ""}.`,
      });
      return;
    }
    const next = parsed.data;
    const cur = runRef.current;
    if (cur && cur.id === next.id && next.version < cur.version) return; // stale
    if (cur && cur.id !== next.id) {
      // A different run (reset elsewhere): drop history and replay from the start.
      lastSeqRef.current = 0;
      setEvents([]);
      setStreamKey((k) => k + 1);
    }
    runRef.current = next;
    setRun(next);
    if (catchupTimer.current && next.lastSeq >= lastSeqRef.current) {
      clearTimeout(catchupTimer.current);
      catchupTimer.current = null;
    }
  }, [showNotice]);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/runs/current", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { run?: unknown; status?: unknown };
      applySnapshot(body.run);
      const st = IntegrationStatus.safeParse(body.status);
      if (st.success) setStatus(st.data);
      return true;
    } catch (err) {
      showNotice({ tone: "error", title: "Could not load the run", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, [applySnapshot, showNotice]);

  const applyEvent = useCallback((raw: unknown) => {
    const parsed = RunEvent.safeParse(raw);
    if (!parsed.success) {
      console.warn("Clearing: dropped an event that failed contract validation", parsed.error.issues.slice(0, 5));
      return;
    }
    const ev = parsed.data;
    const cur = runRef.current;
    if (cur && ev.runId !== cur.id) return; // the following snapshot will realign us
    if (ev.seq <= lastSeqRef.current) {
      // Replay overlap after a reconnect: keep the list deduped.
      setEvents((list) => (list.some((e) => e.seq === ev.seq) ? list : [...list, ev].sort((a, b) => a.seq - b.seq)));
      return;
    }
    lastSeqRef.current = ev.seq;
    setEvents((list) => [...list, ev]);
    // If the run snapshot has not caught up with this event, fetch it shortly.
    if (!cur || cur.lastSeq < ev.seq) {
      if (catchupTimer.current) clearTimeout(catchupTimer.current);
      catchupTimer.current = setTimeout(() => {
        catchupTimer.current = null;
        if ((runRef.current?.lastSeq ?? 0) < lastSeqRef.current) void fetchSnapshot();
      }, SNAPSHOT_CATCHUP_MS);
    }
  }, [fetchSnapshot]);

  // Snapshot + event stream with reconnect/backoff.
  useEffect(() => {
    if (isStatic) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closed = false;

    const open = () => {
      if (closed) return;
      es = new EventSource(`/api/runs/current/events?after=${lastSeqRef.current}`);
      es.onopen = () => {
        attempt = 0;
        setConnection("live");
      };
      es.addEventListener("run.snapshot", (e) => {
        try {
          applySnapshot(JSON.parse((e as MessageEvent<string>).data));
        } catch {
          /* malformed frame: ignored */
        }
      });
      es.addEventListener("run.event", (e) => {
        try {
          applyEvent(JSON.parse((e as MessageEvent<string>).data));
        } catch {
          /* malformed frame: ignored */
        }
      });
      es.onerror = () => {
        es?.close();
        if (closed) return;
        setConnection("reconnecting");
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(open, delay);
      };
    };

    (async () => {
      if (streamKey === 0) await fetchSnapshot();
      open();
    })();

    return () => {
      closed = true;
      es?.close();
      if (timer) clearTimeout(timer);
    };
  }, [isStatic, streamKey, applySnapshot, applyEvent, fetchSnapshot]);

  useEffect(
    () => () => {
      if (catchupTimer.current) clearTimeout(catchupTimer.current);
    },
    [],
  );

  const refreshStatus = useCallback(async (): Promise<IntegrationStatusT | null> => {
    if (isStatic) return source?.status ?? null;
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (!res.ok) return null;
      const parsed = IntegrationStatus.safeParse(await res.json());
      if (parsed.success) {
        setStatus(parsed.data);
        return parsed.data;
      }
    } catch {
      /* keep the last known status */
    }
    return null;
  }, [isStatic, source]);

  const post = useCallback(
    async (label: string, path: string, body: Record<string, unknown> | null, withKeyInBody: boolean): Promise<boolean> => {
      if (isStatic) {
        showNotice({ tone: "info", title: "Dev sample", message: `“${label}” is disabled on static sample data. Open / for the live console.` });
        return false;
      }
      const key = newKey();
      setPending(label);
      try {
        const payload = withKeyInBody ? { ...(body ?? {}), idempotencyKey: key } : body;
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: payload ? JSON.stringify(payload) : "{}",
        });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (!res.ok) {
          const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
          showNotice({
            tone: "error",
            title: `${label} was refused${res.status === 409 ? " (conflict)" : ""}`,
            message: err?.message ?? `HTTP ${res.status}`,
            codes: rejectCodesFrom(data),
          });
          if (res.status === 409) void fetchSnapshot();
          return false;
        }
        const returned = data && typeof data === "object" && "run" in data ? (data as { run: unknown }).run : null;
        if (returned) applySnapshot(returned);
        return true;
      } catch (err) {
        showNotice({ tone: "error", title: `${label} failed`, message: err instanceof Error ? err.message : "Network error" });
        return false;
      } finally {
        setPending(null);
      }
    },
    [isStatic, showNotice, applySnapshot, fetchSnapshot],
  );

  const commands = useMemo<RunCommands>(
    () => ({
      submitRequest: (input) => post("Submit request", "/api/runs/current/request", input, false),
      confirm: (edits) => post("Confirm requirements", "/api/runs/current/confirm", edits && Object.keys(edits).length ? { edits } : {}, false),
      approve: (planRevision) => post("Approve", "/api/runs/current/approve", { planRevision }, true),
      disrupt: (disruption) => post("Disruption", "/api/runs/current/disrupt", { disruption }, true),
      settleRefund: (orderId) => post("Settle refund", "/api/runs/current/settle-refund", { orderId }, true),
      updateBudget: (budgetCents) => post("Budget change", "/api/runs/current/budget", { budgetCents }, true),
      reset: async () => {
        const ok = await post("Reset", "/api/reset", null, false);
        if (ok) {
          lastSeqRef.current = 0;
          setEvents([]);
          setStreamKey((k) => k + 1);
        }
        return ok;
      },
    }),
    [post],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { run, events, status, connection, pending, notice, dismissNotice, refreshStatus, commands, isStatic };
}
