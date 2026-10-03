import type { IntegrationStatus } from "../contracts";
import { MOSS_INDEX_NAME, mossProcessStatus } from "../discovery/types";
import { bandConfigured, bandLiveVerified } from "../coordination/band-state";
import { zooworkLiveVerified } from "./zoowork";

/** Presence-only credential checks. Values are never read into logs or responses. */
export function integrationStatus(env: NodeJS.ProcessEnv = process.env): IntegrationStatus {
  const live = env.CLEARING_REASONING === "live" && Boolean(env.ANTHROPIC_API_KEY);
  const zoowork = env.CLEARING_REASONING === "zoowork" && Boolean(env.ZOOWORK_API_KEY);
  const zwVerified = zooworkLiveVerified();
  const band = bandConfigured(env);
  const bandLive = band ? bandLiveVerified() : null;
  return {
    reasoning: zoowork
      ? { mode: "live", provider: zwVerified ? `ZooWork Managed Agents · ${zwVerified.model} (live-verified this process)` : "ZooWork Managed Agents · planner role (unverified until first successful call)", verified: Boolean(zwVerified) }
      : live
        ? { mode: "live", provider: `Anthropic · ${env.CLEARING_MODEL ?? "claude-opus-5-5"} (unverified until first successful call)`, verified: false }
        : { mode: "local", provider: "Local rules", verified: true },
    supply: "Fictional demo catalog",
    coordination: bandLive ? "BAND room (live-verified)" : band ? "BAND room (unverified; local fallback)" : "Local transport",
    execution: "Simulated orders",
    tavily: { connected: false, note: env.TAVILY_API_KEY ? "Key present; adapter not enabled in this build" : "Not connected — requires TAVILY_API_KEY" },
    zoowork: zoowork
      ? { connected: Boolean(zwVerified), note: zwVerified ? `Planner/buyer role runs on ZooWork Agent ${zwVerified.agentId} (${zwVerified.model}); replies enter the pipeline after schema validation` : "Configured: planner/buyer role on ZooWork Managed Agents; unverified until a successful call is recorded" }
      : { connected: false, note: "Not connected — set CLEARING_REASONING=zoowork and ZOOWORK_API_KEY (funded ZooWork project, Developer Preview)" },
    band: bandLive
      ? { connected: true, note: `Live-verified: room ${bandLive.roomId}, ${bandLive.roundTrips} round trips`.slice(0, 200) }
      : band
        ? { connected: false, note: "Configured: negotiation runs through a BAND room (buyer agent + seller agent processes); unverified until a round trip completes" }
        : { connected: false, note: "Not connected — requires BAND_BUYER_AGENT_ID + BAND_BUYER_API_KEY (Remote Agents from app.band.ai) and seller agent processes" },
    paceMs: Math.max(0, Number(env.CLEARING_PACE_MS ?? 350) || 0),
  };
}

export interface DiscoveryStatus {
  engine: "moss" | "local-keyword";
  connected: boolean;
  note: string;
}

/**
 * Supplier discovery status, kept apart from IntegrationStatus. Credentials are
 * checked for presence only. Moss counts as connected only after a real query
 * succeeded in this process; discovery results are never executable offers.
 */
export function discoveryStatus(env: Readonly<Record<string, string | undefined>> = process.env): DiscoveryStatus {
  if (!(env.MOSS_PROJECT_ID && env.MOSS_PROJECT_KEY)) {
    return { engine: "local-keyword", connected: false, note: "Moss not connected — set MOSS_PROJECT_ID and MOSS_PROJECT_KEY; using the local keyword matcher (candidates only, never offers)" };
  }
  const seen = mossProcessStatus();
  if (seen?.ok) return { engine: "moss", connected: true, note: `Moss index "${MOSS_INDEX_NAME}" answered a query in this process (${seen.indexed} documents)` };
  return {
    engine: "moss",
    connected: false,
    note: seen?.lastError ? `Moss configured but the last attempt failed: ${seen.lastError}` : "Moss credentials present; unverified until the first successful query",
  };
}

// ---------------------------------------------------------------------------
// Runtime mode (additive). The IntegrationStatus contract has no runtime field,
// so the mode is exposed through this helper (server code), clientRuntimeMode()
// and the `runtime` field of useRunStream() (client code).
// ---------------------------------------------------------------------------

export type RuntimeMode = "server" | "browser";

/**
 * "browser" when the build was made with NEXT_PUBLIC_CLEARING_RUNTIME=browser:
 * the whole market simulation runs in the visitor's browser and the server
 * routes answer 501. Anything else is the default server mode.
 */
export function runtimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return env.NEXT_PUBLIC_CLEARING_RUNTIME === "browser" ? "browser" : "server";
}

/** The browser runtime reports its own status: see `browserIntegrationStatus()` in lib/browser-runtime.ts. */
