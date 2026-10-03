import Link from "next/link";

const WHAT: Record<"agent" | "attendee", string> = {
  agent: "The agent front door calls the server API, which is disabled in this deployment: every call below answers 501.",
  attendee: "Attendee links are stored on the organizer's server, which this deployment does not have, so this link cannot be opened here.",
};

/**
 * Shown on pages that need the server when the build runs the browser runtime
 * (NEXT_PUBLIC_CLEARING_RUNTIME=browser). Renders nothing in server mode.
 */
export function ServerModeNotice({ page }: { page: "agent" | "attendee" }) {
  if (process.env.NEXT_PUBLIC_CLEARING_RUNTIME !== "browser") return null;
  return (
    <div role="note" className={page === "attendee" ? "mx-auto w-full max-w-xl px-4 py-8" : "w-full"}>
      <div className="rounded-lg border border-dashed border-amber/60 bg-surface px-4 py-3 text-[13px] leading-snug text-text">
        <p className="font-semibold text-amber">Needs the server mode</p>
        <p className="mt-1 text-muted">
          {WHAT[page]} This deployment runs the browser runtime: the market simulation runs in each visitor&apos;s browser and state is saved on that device only. Run Clearing locally in server mode (<code>npm run dev</code>) to use this page.
        </p>
        <p className="mt-2">
          <Link href="/" className="text-accent underline underline-offset-2">
            Open the organizer console
          </Link>
        </p>
      </div>
    </div>
  );
}
