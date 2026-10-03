/**
 * Compact, agent-facing projections of a Run. Pure functions: no store, no
 * clock. Everything here is derived from server-owned state; no merchant
 * free text (descriptions, offer notes) is passed through.
 */
import { RequirementField, type Phase, type Plan, type Requirements, type Run } from "@/lib/contracts";
import { integrationStatus } from "@/lib/providers/status";

export type RequestNextAction = "confirm" | "fix_missing";

export interface Labels {
  supply: string;
  reasoning: string;
  execution: string;
}

export function labels(): Labels {
  const s = integrationStatus();
  return { supply: s.supply, reasoning: s.reasoning.provider, execution: s.execution };
}

/** What an agent should put in `edits` to resolve each missing field. */
export const MISSING_FIELD_EDIT: Partial<Record<RequirementField, string>> = {
  headcount: "edits.headcount (integer)",
  vegetarianMin: "edits.vegetarianMin (integer)",
  readyBy: "edits.readyByLocal (HH:MM, 24h)",
  budget: "edits.budgetCents (integer cents)",
};

export function requirementsView(req: Requirements) {
  const missing = new Set(req.missing);
  return {
    confirmed: RequirementField.options.filter((f) => req.fieldStatus[f] === "confirmed"),
    assumed: req.assumptions.map(({ field, note }) => ({ field, note })),
    missing: [...req.missing],
    /** The interpreted values, so an agent can check them before confirming. Missing fields are null. */
    values: {
      objective: req.objective,
      venue: req.venue.name,
      eventDate: req.eventDate,
      timezone: req.timezone,
      nowLocal: req.nowLocal,
      readyByLocal: missing.has("readyBy") ? null : req.readyByLocal,
      headcount: missing.has("headcount") ? null : req.headcount,
      vegetarianMin: missing.has("vegetarianMin") ? null : req.vegetarianMin,
      budgetCents: missing.has("budget") ? null : req.budgetCents,
      items: req.items,
    },
    ...(req.missing.length > 0
      ? { howToFix: Object.fromEntries(req.missing.map((f) => [f, MISSING_FIELD_EDIT[f] ?? "edit the request text and resend"])) }
      : {}),
  };
}

export function requestNextAction(req: Requirements): RequestNextAction {
  return req.missing.length > 0 ? "fix_missing" : "confirm";
}

export type PlanNextAction = "confirm" | "fix_missing" | "poll" | "await_organizer_approval" | "approve" | "revise_request" | "done";

const BUSY_PHASES: readonly Phase[] = ["collecting", "negotiating", "clearing", "disrupted", "repairing"];

export function planNextAction(run: Run, agentCanApprove: boolean): PlanNextAction {
  if (BUSY_PHASES.includes(run.phase)) return "poll";
  switch (run.phase) {
    case "draft":
    case "confirming":
      return run.requirements && run.requirements.missing.length > 0 ? "fix_missing" : "confirm";
    case "proposed":
    case "needs_approval":
      return agentCanApprove ? "approve" : "await_organizer_approval";
    case "no_feasible_plan":
      return "revise_request";
    default:
      return "done";
  }
}

function currentPlan(run: Run): Plan | null {
  if (run.currentPlanRevision === null) return null;
  return run.plans.find((p) => p.revision === run.currentPlanRevision) ?? null;
}

export function planView(run: Run, agentCanApprove: boolean) {
  const plan = currentPlan(run);
  const inf = run.infeasibility;
  return {
    runId: run.id,
    phase: run.phase,
    nextAction: planNextAction(run, agentCanApprove),
    plan: plan
      ? {
          revision: plan.revision,
          status: plan.status,
          totalCents: plan.totals.totalCents,
          remainingCents: plan.budget.remainingCents,
          slackMinutes: plan.schedule.slackMinutes,
          selections: plan.selections.map((s) => ({ merchant: s.merchantName, group: s.group, totalCents: s.totalCents, change: s.change })),
          unresolvedConditions: [...plan.unresolvedConditions],
          /** True while the plan still needs the organizer's approval; false once it has been approved. */
          approvalRequired: plan.status === "proposed",
        }
      : null,
    infeasibility: inf
      ? {
          kind: inf.kind,
          summary: inf.summary,
          budgetGapCents: inf.cheapestInvalid?.budgetGapCents ?? null,
          cheapestMerchants: inf.cheapestInvalid?.merchants ?? [],
          details: [...inf.details],
        }
      : null,
    labels: labels(),
  };
}
