import type { IntegrationStatus } from "../contracts";
import { zooworkLiveVerified } from "./zoowork";

/** Presence-only credential checks. Values are never read into logs or responses. */
export function integrationStatus(env: NodeJS.ProcessEnv = process.env): IntegrationStatus {
  const live = env.CLEARING_REASONING === "live" && Boolean(env.ANTHROPIC_API_KEY);
  const zoowork = env.CLEARING_REASONING === "zoowork" && Boolean(env.ZOOWORK_API_KEY);
  const zwVerified = zooworkLiveVerified();
  return {
    reasoning: zoowork
      ? { mode: "live", provider: zwVerified ? `ZooWork Managed Agents · ${zwVerified.model} (live-verified this process)` : "ZooWork Managed Agents · planner role (unverified until first successful call)", verified: Boolean(zwVerified) }
      : live
        ? { mode: "live", provider: `Anthropic · ${env.CLEARING_MODEL ?? "claude-opus-5-5"} (unverified until first successful call)`, verified: false }
        : { mode: "local", provider: "Local rules", verified: true },
    supply: "Fictional demo catalog",
    coordination: "Local transport",
    execution: "Simulated orders",
    tavily: { connected: false, note: env.TAVILY_API_KEY ? "Key present; adapter not enabled in this build" : "Not connected — requires TAVILY_API_KEY" },
    zoowork: zoowork
      ? { connected: Boolean(zwVerified), note: zwVerified ? `Planner/buyer role runs on ZooWork Agent ${zwVerified.agentId} (${zwVerified.model}); replies enter the pipeline after schema validation` : "Configured: planner/buyer role on ZooWork Managed Agents; unverified until a successful call is recorded" }
      : { connected: false, note: "Not connected — set CLEARING_REASONING=zoowork and ZOOWORK_API_KEY (funded ZooWork project, Developer Preview)" },
    band: { connected: false, note: "Not connected — requires a BAND Remote Agent (agent_id + api_key from app.band.ai)" },
    paceMs: Math.max(0, Number(env.CLEARING_PACE_MS ?? 350) || 0),
  };
}
