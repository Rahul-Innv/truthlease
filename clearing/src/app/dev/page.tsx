import { Console } from "@/components/Console";
import { DevNav } from "@/components/dev/DevNav";
import { SAMPLE_STATES, sampleRun, type SampleState } from "@/components/dev/sampleRun";

export const dynamic = "force-dynamic";

/** Visual harness: renders the console from hand-built sample runs (no API). */
export default async function DevPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.state) ? sp.state[0] : sp.state;
  const state: SampleState = (SAMPLE_STATES as readonly string[]).includes(raw ?? "") ? (raw as SampleState) : "cleared";
  return <Console key={state} source={sampleRun(state)} banner={<DevNav states={SAMPLE_STATES} current={state} />} />;
}
