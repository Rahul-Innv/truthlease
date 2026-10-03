import type { Metadata } from "next";
import Link from "next/link";
import { PRESET_TEXT } from "@/lib/fixtures";
import { integrationStatus } from "@/lib/providers/status";
import { AgentConsole } from "./AgentConsole";
import { ServerModeNotice } from "@/components/ServerModeNotice";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Clearing — agent front door",
  description: "What a personal agent sends to Clearing and what it gets back. Demo suppliers · Local rules · Simulated orders.",
};

/** Server shell: reads the live labels, renders the header, hands the preset text to the client component. */
export default function AgentPage() {
  const reasoning = integrationStatus().reasoning.mode === "live" ? "Live model (unverified)" : "Local rules";
  const line = `Agent front door · Demo suppliers · ${reasoning} · Simulated orders`;
  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 px-4 py-4 sm:px-6 sm:py-6">
      <ServerModeNotice page="agent" />
      <header className="flex flex-col gap-3 border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-mono text-xs font-semibold uppercase tracking-[0.08em] text-muted">Clearing / agent</span>
            <p className="min-w-0 rounded-md border border-dashed border-amber/50 bg-amber/5 px-2 py-1 text-xs font-medium leading-snug text-amber">{line}</p>
          </div>
          <Link href="/" className="inline-flex h-8 shrink-0 items-center rounded-md border border-line bg-surface-2 px-3 text-xs font-medium text-text hover:border-muted/60">
            Console
          </Link>
        </div>
        <div className="flex flex-col gap-1.5 lg:flex-row lg:items-baseline lg:gap-6">
          <h1 className="shrink-0 text-xl font-semibold leading-tight text-text">Clearing, as an agent sees it</h1>
          <p className="max-w-3xl text-[13px] leading-relaxed text-muted">
            Each button makes the same HTTP call a personal agent would make, and the transcript shows the raw JSON in both directions. An agent can submit, confirm and read; approval stays with the organizer in the{" "}
            <Link href="/" className="text-accent underline underline-offset-2">
              console
            </Link>
            , which shows this same run live. The machine-readable manifest is at{" "}
            <a href="/api/agent" className="font-mono text-accent underline underline-offset-2">
              /api/agent
            </a>
            .
          </p>
        </div>
      </header>
      <AgentConsole presetText={PRESET_TEXT} />
    </main>
  );
}
