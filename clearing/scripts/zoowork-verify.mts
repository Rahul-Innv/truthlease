/**
 * One-command live verification of the ZooWork planner role.
 * Usage: CLEARING_REASONING=zoowork ZOOWORK_API_KEY=... npx tsx scripts/zoowork-verify.ts
 * Makes at most two billable calls. Prints evidence; never prints the key.
 */
import { PRESET_TEXT } from "../src/lib/fixtures";
import { liveProvider } from "../src/lib/providers/live";
import { zooworkTransportFromEnv } from "../src/lib/providers/zoowork";

const transport = await zooworkTransportFromEnv(process.env);
if (!transport) {
  console.error("Set CLEARING_REASONING=zoowork and ZOOWORK_API_KEY first.");
  process.exit(2);
}
const events: unknown[] = [];
const provider = liveProvider({ transport, maxCalls: 2, timeoutMs: 90_000, onEvent: (e) => events.push(e) });
const started = Date.now();
const r = await provider.interpret(PRESET_TEXT);
console.log(JSON.stringify({ reasoning: r.reasoning, fallback: r.fallback ?? null, callsUsed: r.callsUsed, ms: Date.now() - started, extracted: r.value, events }, null, 2));
process.exit(r.reasoning === "live" ? 0 : 1);
