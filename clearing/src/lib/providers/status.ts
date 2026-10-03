import type { IntegrationStatus } from "../contracts";

/** Presence-only credential checks. Values are never read into logs or responses. */
export function integrationStatus(env: NodeJS.ProcessEnv = process.env): IntegrationStatus {
  const live = env.CLEARING_REASONING === "live" && Boolean(env.ANTHROPIC_API_KEY);
  return {
    reasoning: live
      ? { mode: "live", provider: `Anthropic · ${env.CLEARING_MODEL ?? "claude-opus-5-5"} (unverified until first successful call)`, verified: false }
      : { mode: "local", provider: "Local rules", verified: true },
    supply: "Fictional demo catalog",
    coordination: "Local transport",
    execution: "Simulated orders",
    tavily: { connected: false, note: env.TAVILY_API_KEY ? "Key present; adapter not enabled in this build" : "Not connected — requires TAVILY_API_KEY" },
    zoowork: { connected: false, note: "Not connected — requires ZOOWORK_API_KEY and a funded ZooWork project (Developer Preview)" },
    band: { connected: false, note: "Not connected — requires a BAND Remote Agent (agent_id + api_key from app.band.ai)" },
    paceMs: Math.max(0, Number(env.CLEARING_PACE_MS ?? 350) || 0),
  };
}
