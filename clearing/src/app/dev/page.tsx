import Link from "next/link";
import { Console } from "@/components/Console";
import { SAMPLE_STATES, sampleRun, type SampleState } from "@/components/dev/sampleRun";

export const dynamic = "force-dynamic";

export default async function DevPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.state) ? sp.state[0] : sp.state;
  const state: SampleState = (SAMPLE_STATES as readonly string[]).includes(raw ?? "") ? (raw as SampleState) : "cleared";
  const source = sampleRun(state);
  return (
    <Console
      key={state}
      source={source}
      banner={
        <nav aria-label="Dev sample variants" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-line bg-surface px-4 py-1.5 text-xs">
          <span className="font-medium text-amber">Dev sample · static data · commands disabled</span>
          <span className="text-muted">Variant:</span>
          {SAMPLE_STATES.map((s) => (
            <Link key={s} href={`/dev?state=${s}`} aria-current={s === state ? "page" : undefined} className={s === state ? "font-medium text-text underline underline-offset-4" : "text-accent hover:underline"}>
              {s}
            </Link>
          ))}
          <Link href="/" className="ml-auto text-accent hover:underline">
            Live console →
          </Link>
        </nav>
      }
    />
  );
}
