import type { Run, RunEvent } from "@/lib/contracts";
import { readDiscoveryEvent } from "@/lib/discovery/types";
import { Chip, Glyph, KV } from "./ui";

/**
 * Supplier discovery results from the newest discovery event in the run history.
 * These are unverified candidates, not offers: only demo-catalog merchants can
 * quote or clear. A retrieval score is never shown as confidence; rows show rank.
 */
export function DiscoveryPanel({ run, events, onOpenOffer }: { run: Run; events?: RunEvent[]; onOpenOffer: (merchantId: string) => void }) {
  const view = events ? readDiscoveryEvent(events) : null;
  const marketOpen = run.phase !== "draft" && run.phase !== "confirming";
  const merchantFor = (c: { id: string; name: string }) => run.merchants.find((m) => m.id === c.id) ?? run.merchants.find((m) => m.name === c.name);
  const engineLabel = view?.engine ?? "unknown engine";

  return (
    <section className="border-b border-line px-4 py-3" aria-label="Discovered suppliers">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Discovered suppliers</h3>
        {view?.ok ? <span className="num text-xs text-muted">{view.candidates.length} found</span> : null}
      </div>
      {!view ? (
        <p className="text-[13px] leading-snug text-muted">{marketOpen && events && events.length > 0 ? "No discovery result was recorded for this run." : "Runs at market open."}</p>
      ) : !view.ok ? (
        <p className="flex gap-2 text-xs leading-snug text-amber">
          <Glyph name="warn" className="mt-0.5" />
          <span>Discovery unavailable ({view.reason}). The market opened with the demo catalog only.</span>
        </p>
      ) : (
        <>
          <dl className="mb-1">
            <KV label="Engine">
              <span className="font-mono text-xs">{engineLabel}</span>
            </KV>
            <KV label="Indexed">{view.indexed}</KV>
            <KV label="Search time">{view.ms} ms</KV>
          </dl>
          <p className="mb-2 flex gap-2 text-xs leading-snug text-muted">
            <Glyph name="ring" className="mt-0.5" />
            <span>Unverified candidates, not offers. Only executable demo-catalog suppliers quote in the market.</span>
          </p>
          {view.candidates.length === 0 ? (
            <p className="text-[13px] leading-snug text-muted">No candidates matched this request.</p>
          ) : (
            <ol className="-mx-2 divide-y divide-line/60">
              {view.candidates.map((c, i) => {
                const m = c.executable ? merchantFor(c) : undefined;
                const score = view.engine === "moss" && c.score !== null ? `retrieval score (Moss): ${c.score.toFixed(3)}` : undefined;
                return (
                  <li key={c.id} className={c.executable ? "flex items-start gap-2 rounded-md px-2 py-2" : "flex items-start gap-2 rounded-md px-2 py-1.5 opacity-80"}>
                    <span className="num w-6 shrink-0 pt-0.5 text-right text-xs text-muted" title={score}>
                      #{i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      {m ? (
                        <button type="button" onClick={() => onOpenOffer(m.id)} className="max-w-full truncate text-left text-sm font-medium text-text hover:underline" aria-label={`${c.name}, executable. Open its market node.`}>
                          {c.name}
                        </button>
                      ) : (
                        <span className={c.executable ? "block truncate text-sm font-medium text-text" : "block truncate text-[13px] text-muted"}>{c.name}</span>
                      )}
                      {!c.executable ? <span className="block text-xs leading-snug text-muted">not executable — {c.note}</span> : null}
                    </span>
                    {c.executable ? (
                      <Chip tone="mint" glyph="check" title="Part of the executable demo catalog; it quotes in the market">
                        executable
                      </Chip>
                    ) : (
                      <span title={c.note} className="inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-dashed border-line px-2 text-xs text-muted">
                        <Glyph name="dash" />
                        candidate only
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
