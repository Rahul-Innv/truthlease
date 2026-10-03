import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeAttendToken } from "../src/app/api/attend/_lib/limit";
import { resetRateLimit } from "../src/app/api/agent/_lib/ratelimit";
import { ATTENDEE_DISCLAIMER, ATTENDEE_TOKEN_RE, AttendeePublicView, summarizeAttendees } from "../src/lib/attendee";
import type { Run, RunEvent } from "../src/lib/contracts";
import { fixedClock } from "../src/lib/fixtures";
import { localProvider } from "../src/lib/providers/local";
import { NotFound, PhaseError, ValidationError, createService, type Service } from "../src/lib/service";
import { openStore, type Store } from "../src/lib/store";

let store: Store;
let storeOpen = false;
afterEach(() => {
  if (storeOpen) store.close();
  storeOpen = false;
});

function setup(): Service {
  store = openStore(":memory:");
  storeOpen = true;
  return createService({ store, clock: fixedClock(), provider: localProvider(), paceMs: 0 });
}

const key = (name: string) => `attendee-key-${name}`;
const events = (runId: string): RunEvent[] => store.listEvents(runId, 0, 10_000);
const ofType = (runId: string, type: RunEvent["type"]) => events(runId).filter((e) => e.type === type);
const currentPlan = (run: Run) => run.plans.find((p) => p.revision === run.currentPlanRevision);

async function withLink(service: Service): Promise<{ run: Run; token: string }> {
  const created = await service.createPresetRun();
  const run = await service.createAttendeeLink(created.id, { idempotencyKey: key("link") });
  return { run, token: run.attendeeLink!.token };
}

/** Respondents in groups of at most 6 (the party-size limit). */
async function respond(service: Service, token: string, vegetarian: number, flexible: number, prefix = "resp"): Promise<void> {
  let i = 0;
  for (const [preference, total] of [["vegetarian", vegetarian], ["flexible", flexible]] as const) {
    for (let left = total; left > 0; left -= 6) {
      await service.submitAttendee({ token, respondentId: `${prefix}-${i++}`, preference, partySize: Math.min(6, left) });
    }
  }
}

describe("attendee link", () => {
  it("creates one submit-only link with zeroed counts and keeps the token out of the event log", async () => {
    const service = setup();
    const { run, token } = await withLink(service);
    expect(token).toMatch(ATTENDEE_TOKEN_RE);
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(run.attendeeLink).toMatchObject({ token, enabled: true });
    expect(run.attendeeSummary).toEqual({ responses: 0, people: 0, vegetarian: 0, flexible: 0, appliedAt: null, appliedPeople: null });
    expect(run.phase).toBe("confirming");
    expect(store.findRunIdByAttendeeToken(token)).toBe(run.id);

    const created = ofType(run.id, "attendee.link_created");
    expect(created).toHaveLength(1);
    expect(created[0]!.summary).toBe("Attendee link created");
    expect(JSON.stringify(events(run.id))).not.toContain(token);

    // Same key replays; a new key returns the existing active link instead of minting another.
    const replay = await service.createAttendeeLink(run.id, { idempotencyKey: key("link") });
    expect(replay).toEqual(run);
    const again = await service.createAttendeeLink(run.id, { idempotencyKey: key("link-2") });
    expect(again.attendeeLink?.token).toBe(token);
    expect(ofType(run.id, "attendee.link_created")).toHaveLength(1);
  });

  it("is cleared by reset: the old token no longer resolves and its answers are gone", async () => {
    const service = setup();
    const { run, token } = await withLink(service);
    await respond(service, token, 2, 0);
    expect(store.listAttendeeResponses(run.id)).toHaveLength(1);
    const fresh = await service.reset();
    expect(fresh.attendeeLink ?? null).toBeNull();
    expect(store.findRunIdByAttendeeToken(token)).toBeNull();
    expect(store.listAttendeeResponses(run.id)).toEqual([]);
    expect(() => service.getAttendeeView(token)).toThrow(NotFound);
  });
});

describe("attendee submissions", () => {
  it("upserts by respondent and aggregates counts (the same respondent twice counts once)", async () => {
    const service = setup();
    const { run, token } = await withLink(service);
    const before = service.getRun(run.id)!;

    await service.submitAttendee({ token, respondentId: "browser-a-0001", preference: "vegetarian", partySize: 2 });
    const view = await service.submitAttendee({ token, respondentId: "browser-b-0002", preference: "flexible", partySize: 3 });
    expect(view.summary).toEqual({ responses: 2, people: 5, vegetarian: 2, flexible: 3 });
    expect(service.getRun(run.id)!.attendeeSummary).toMatchObject({ responses: 2, people: 5, vegetarian: 2, flexible: 3 });

    // Respondent A changes their answer: still two responses.
    const updated = await service.submitAttendee({ token, respondentId: "browser-a-0001", preference: "flexible", partySize: 1 });
    expect(updated.summary).toEqual({ responses: 2, people: 4, vegetarian: 0, flexible: 4 });
    expect(store.listAttendeeResponses(run.id)).toHaveLength(2);

    // An identical resubmission writes nothing.
    const versionBefore = service.getRun(run.id)!.version;
    await service.submitAttendee({ token, respondentId: "browser-a-0001", preference: "flexible", partySize: 1 });
    expect(service.getRun(run.id)!.version).toBe(versionBefore);

    // Events carry counts only, never the respondent id.
    const responded = ofType(run.id, "attendee.responded");
    expect(responded).toHaveLength(3);
    for (const e of responded) expect(Object.keys(e.payload).sort()).toEqual(["flexible", "people", "responses", "vegetarian"]);
    expect(JSON.stringify(events(run.id))).not.toMatch(/browser-[ab]/);

    // Submissions never touch the request, requirements, budget or phase.
    const after = service.getRun(run.id)!;
    expect(after.requirements).toEqual(before.requirements);
    expect(after.requestVersion).toBe(before.requestVersion);
    expect(after.phase).toBe(before.phase);
    expect(after.plans).toEqual(before.plans);
  });

  it("rejects unknown, malformed and disabled tokens with NotFound", async () => {
    const service = setup();
    const { run, token } = await withLink(service);
    const submit = (t: string) => service.submitAttendee({ token: t, respondentId: "browser-x-0001", preference: "vegetarian", partySize: 1 });

    await expect(submit("0".repeat(48))).rejects.toBeInstanceOf(NotFound);
    await expect(submit("not-a-token")).rejects.toBeInstanceOf(NotFound);
    expect(() => service.getAttendeeView("f".repeat(48))).toThrow(NotFound);
    await expect(service.submitAttendee({ token, respondentId: "x", preference: "vegetarian", partySize: 7 } as never)).rejects.toBeInstanceOf(ValidationError);

    // Disable the link (as an organizer action would) by a versioned write.
    const cur = service.getRun(run.id)!;
    store.commit({ run: { ...cur, attendeeLink: { ...cur.attendeeLink!, enabled: false } }, expectedVersion: cur.version, events: [] });
    await expect(submit(token)).rejects.toBeInstanceOf(NotFound);
    expect(store.listAttendeeResponses(run.id)).toEqual([]);
    expect(service.getAttendeeView(token).enabled).toBe(false);
  });

  it("aggregates with the documented formula", () => {
    const at = "2026-10-16T21:00:00.000Z";
    const s = summarizeAttendees([
      { respondentId: "r-0001", preference: "vegetarian", partySize: 2, submittedAt: at },
      { respondentId: "r-0002", preference: "flexible", partySize: 3, submittedAt: at },
      { respondentId: "r-0003", preference: "vegetarian", partySize: 1, submittedAt: at },
    ]);
    expect(s).toEqual({ responses: 3, people: 6, vegetarian: 3, flexible: 3, appliedAt: null, appliedPeople: null });
  });
});

describe("public attendee view", () => {
  it("exposes only the event summary and counts: no budget, plan, offers, run id or token", async () => {
    const service = setup();
    const { run, token } = await withLink(service);
    await respond(service, token, 2, 3);
    const view = service.getAttendeeView(token);
    expect(Object.keys(view).sort()).toEqual(["enabled", "eventDate", "objective", "readyByLocal", "summary", "timezone", "venueName"]);
    expect(Object.keys(view.summary).sort()).toEqual(["flexible", "people", "responses", "vegetarian"]);
    expect(AttendeePublicView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ objective: "Dinner", readyByLocal: "18:30", timezone: "America/Los_Angeles", enabled: true, summary: { responses: 2, people: 5, vegetarian: 2, flexible: 3 } });

    const text = JSON.stringify(view);
    for (const forbidden of ["budget", "plan", "offer", "order", "approval", "merchant", "policy", "100000", "1,000", run.id, token]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(ATTENDEE_DISCLAIMER).toBe("Your answer only helps the organizer plan quantities. It is not an order, a reservation, or a payment.");
  });
});

describe("applying attendee counts", () => {
  it("in confirming: updates headcount and vegetarian minimum only", async () => {
    const service = setup();
    const { run, token } = await withLink(service);
    await expect(service.applyAttendeeCounts(run.id, { idempotencyKey: key("apply-0") })).rejects.toBeInstanceOf(PhaseError);
    await respond(service, token, 2, 3);

    const applied = await service.applyAttendeeCounts(run.id, { idempotencyKey: key("apply-1") });
    expect(applied.phase).toBe("confirming");
    expect(applied.job).toBeNull();
    expect(applied.requestVersion).toBe(run.requestVersion + 1);
    expect(applied.requirements).toMatchObject({ headcount: 5, vegetarianMin: 2, budgetCents: run.requirements!.budgetCents });
    expect(applied.requirements!.fieldStatus.headcount).toBe("confirmed");
    expect(applied.requirements!.fieldStatus.vegetarianMin).toBe("confirmed");
    expect(applied.requirements!.assumptions).toContainEqual({ field: "headcount", note: "Counts applied from 2 attendee responses" });
    expect(applied.attendeeSummary).toMatchObject({ responses: 2, people: 5, appliedPeople: 5 });
    expect(applied.attendeeSummary!.appliedAt).not.toBeNull();
    expect(applied.disruptions).toEqual([]);
    const ev = ofType(run.id, "attendee.applied");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ responses: 2, people: 5, vegetarian: 2, flexible: 3, previous: { headcount: 60, vegetarianMin: 20 }, repair: false });

    // Idempotent by key; re-applying identical counts is refused as unchanged.
    expect(await service.applyAttendeeCounts(run.id, { idempotencyKey: key("apply-1") })).toEqual(applied);
    await expect(service.applyAttendeeCounts(run.id, { idempotencyKey: key("apply-2") })).rejects.toMatchObject({ code: "unchanged" });
    expect(ofType(run.id, "attendee.applied")).toHaveLength(1);
  });

  it("after an approved plan: re-quotes and repairs like a headcount change, and the repair needs fresh approval", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await service.confirmRequirements(created.id);
    const proposed = await service.drain(created.id);
    const approved = await service.approve(created.id, { planRevision: proposed.currentPlanRevision!, idempotencyKey: key("approve-1") });
    expect(approved.phase).toBe("simulated_confirmed");
    const approvedRevision = approved.currentPlanRevision!;

    const linked = await service.createAttendeeLink(created.id, { idempotencyKey: key("link") });
    const token = linked.attendeeLink!.token;
    await respond(service, token, 24, 40); // 64 people, 24 vegetarian
    expect(service.getRun(created.id)!.phase).toBe("simulated_confirmed"); // answers alone change nothing

    const applied = await service.applyAttendeeCounts(created.id, { idempotencyKey: key("apply") });
    expect(applied.phase).toBe("disrupted");
    expect(applied.job?.kind).toBe("repair");
    expect(applied.requestVersion).toBe(approved.requestVersion + 1);
    expect(applied.requirements).toMatchObject({ headcount: 64, vegetarianMin: 24 });
    expect(applied.disruptions.at(-1)?.input).toEqual({ type: "headcount_changed", headcount: 64 });
    expect(ofType(created.id, "offer.requoted").length).toBeGreaterThan(0);
    // Same command again (same key) does not inject a second disruption.
    await service.applyAttendeeCounts(created.id, { idempotencyKey: key("apply") });
    expect(ofType(created.id, "disruption.injected")).toHaveLength(1);

    const repaired = await service.drain(created.id);
    expect(repaired.phase).toBe("needs_approval");
    expect(repaired.requirements?.headcount).toBe(64);
    const plan = currentPlan(repaired)!;
    expect(plan.status).toBe("proposed");
    expect(plan.revision).toBeGreaterThan(approvedRevision);
    expect(plan.requestVersion).toBe(repaired.requestVersion);
    expect(plan.coverage.meal_vegetarian?.supplied ?? 0).toBeGreaterThanOrEqual(24);
    expect(ofType(created.id, "plan.repaired")).toHaveLength(1);
    // The approved plan is untouched until the organizer approves the repair.
    expect(repaired.plans.find((p) => p.revision === approvedRevision)?.status).toBe("approved");

    const reapproved = await service.approve(created.id, { planRevision: plan.revision, idempotencyKey: key("approve-2") });
    expect(reapproved.phase).toBe("simulated_confirmed");
    expect(currentPlan(reapproved)?.status).toBe("approved");
  });

  it("is refused while the market is working and without a link", async () => {
    const service = setup();
    const created = await service.createPresetRun();
    await expect(service.applyAttendeeCounts(created.id, { idempotencyKey: key("no-link") })).rejects.toMatchObject({ code: "no_attendee_link" });
    const linked = await service.createAttendeeLink(created.id);
    await respond(service, linked.attendeeLink!.token, 2, 3);
    await service.confirmRequirements(created.id);
    await expect(service.applyAttendeeCounts(created.id, { idempotencyKey: key("busy") })).rejects.toBeInstanceOf(PhaseError);
    // Answers are still accepted while the job runs; the pipeline recomputes on the fresh version.
    await service.submitAttendee({ token: linked.attendeeLink!.token, respondentId: "late-0001", preference: "vegetarian", partySize: 1 });
    const done = await service.drain(created.id);
    expect(done.phase).toBe("proposed");
    expect(done.attendeeSummary).toMatchObject({ responses: 3, people: 6 });
  });
});

describe("public submit rate limit", () => {
  beforeEach(() => resetRateLimit());
  afterEach(() => resetRateLimit());

  const req = (ip: string) => new Request("http://localhost/api/attend/x", { method: "POST", headers: { "x-forwarded-for": ip } });

  it("allows 10 submissions per minute per client, then refills", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(takeAttendToken(req("203.0.113.7"), t0).ok).toBe(true);
    const refused = takeAttendToken(req("203.0.113.7"), t0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(6);
    expect(takeAttendToken(req("198.51.100.9"), t0).ok).toBe(true); // other clients are unaffected
    // Six seconds later there is room for exactly one more.
    expect(takeAttendToken(req("203.0.113.7"), t0 + 6_000).ok).toBe(true);
    expect(takeAttendToken(req("203.0.113.7"), t0 + 6_000).ok).toBe(false);
  });
});
