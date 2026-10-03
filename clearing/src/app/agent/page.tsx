import type { Metadata } from "next";
import Link from "next/link";
import { PRESET_TEXT } from "@/lib/fixtures";
import { integrationStatus } from "@/lib/providers/status";
import { AgentConsole } from "./AgentConsole";

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
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-4 sm:py-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 rounded-md border border-dashed border-amber/50 px-2 py-1 text-xs font-medium leading-snug text-amber">{line}</p>
          <Link href="/" className="inline-flex h-8 shrink-0 items-center rounded-md border border-line px-2.5 text-xs font-medium text-text hover:bg-surface-2">
            Console
          </Link>
        </div>
        <h1 className="text-xl font-semibold leading-tight text-text">Clearing, as an agent sees it</h1>
        <p className="text-[13px] leading-relaxed text-muted">
          Each button makes the same HTTP call a personal agent would make, and the transcript shows the raw JSON in both directions. An agent can submit, confirm and read; approval stays with the organizer in the{" "}
          <Link href="/" className="text-accent underline underline-offset-2">
            console
          </Link>
          , which shows this same run live. The machine-readable manifest is at{" "}
          <a href="/api/agent" className="text-accent underline underline-offset-2">
            /api/agent
          </a>
          .
        </p>
      </header>
      <AgentConsole presetText={PRESET_TEXT} />
    </main>
  );
}
