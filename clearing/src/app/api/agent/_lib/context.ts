/**
 * What the agent routes need from the app: the service, a clock for the
 * "next demo Friday" default, and the job re-arm hook.
 *
 * Production resolves these from the app singletons. Tests install an isolated
 * in-memory service with a fixed clock through `setAgentRuntimeForTests`; the
 * setter refuses to run under NODE_ENV=production so it cannot change a real
 * deployment's behaviour.
 */
import { getService, rearmJob } from "@/lib/app";
import type { Run } from "@/lib/contracts";
import type { Service } from "@/lib/service";

export interface AgentRuntime {
  service: Service;
  now(): Date;
  /** Re-arm a stored job that has no in-process runner (process restart or HMR). */
  rearm(run: Run): void;
}

let injected: AgentRuntime | null = null;

export function setAgentRuntimeForTests(runtime: AgentRuntime | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setAgentRuntimeForTests is not available in production.");
  injected = runtime;
}

export async function agentRuntime(): Promise<AgentRuntime> {
  if (injected) return injected;
  const service = await getService();
  return { service, now: () => new Date(), rearm: (run) => rearmJob(service, run) };
}
