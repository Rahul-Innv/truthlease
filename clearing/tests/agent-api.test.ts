import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as manifestGet } from "../src/app/api/agent/route";
import { POST as approvePost } from "../src/app/api/agent/approve/route";
import { POST as confirmPost } from "../src/app/api/agent/confirm/route";
import { GET as planGet } from "../src/app/api/agent/plan/route";
import { POST as requestPost } from "../src/app/api/agent/request/route";
import { setAgentRuntimeForTests } from "../src/app/api/agent/_lib/context";
import { RATE_LIMIT_PER_MINUTE, resetRateLimit } from "../src/app/api/agent/_lib/ratelimit";
import { EXPECTED, FIXED_NOW_ISO, PRESET_TEXT, REQUESTS, fixedClock } from "../src/lib/fixtures";
import { localProvider } from "../src/lib/providers/local";
import { createService, type Service } from "../src/lib/service";
import { openStore, type Store } from "../src/lib/store";

const URL_BASE = "http://localhost/api/agent";
const KEY = (name: string) => `agent-key-${name}`;

let store: Store;
let service: Service;
let savedApproveFlag: string | undefined;

beforeEach(() => {
  store = openStore(":memory:");
  const clock = fixedClock();
  service = createService({ store, clock, provider: localProvider(), paceMs: 0 });
  setAgentRuntimeForTests({ service, now: () => new Date(FIXED_NOW_ISO), rearm: () => {} });
  resetRateLimit();
  savedApproveFlag = process.env.CLEARING_AGENT_CAN_APPROVE;
  delete process.env.CLEARING_AGENT_CAN_APPROVE;
});

afterEach(() => {
  setAgentRuntimeForTests(null);
  resetRateLimit();
  if (savedApproveFlag === undefined) delete process.env.CLEARING_AGENT_CAN_APPROVE;
  else process.env.CLEARING_AGENT_CAN_APPROVE = savedApproveFlag;
  store.close();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = (path = "", headers: Record<string, string> = {}) => new Request(`${URL_BASE}${path}`, { headers });

// The handlers' JSON is `any` for assertions; the shapes are what an agent would read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function read(res: Response): Promise<Json> {
  return res.json();
}

async function sendRequest(text: string, extra: Record<string, unknown> = {}, name = "req") {
  const res = await requestPost(post("/request", { text, idempotencyKey: KEY(name), ...extra }));
  return { res, body: await read(res) };
}

/** request -> confirm -> drain the job (tests call drain; the app's background runner does this in production). */
async function proposedPreset() {
  const sent = await sendRequest(PRESET_TEXT);
  expect(sent.res.status).toBe(200);
  const confirmed = await confirmPost(post("/confirm", { idempotencyKey: KEY("confirm") }));
  expect(confirmed.status).toBe(200);
  const run = await service.drain((await read(confirmed)).runId);
  expect(run.phase).toBe("proposed");
  return run;
}

describe("GET /api/agent (manifest)", () => {
  it("describes the front door, its labels, its authority limit and every endpoint", async () => {
    const res = await manifestGet(get());
    expect(res.status).toBe(200);
    const m = await read(res);
    expect(m).toMatchObject({
      name: "Clearing",
      simulated: true,
      labels: { supply: "Fictional demo catalog", reasoning: "Local rules", execution: "Simulated orders" },
      authority: { agentCanApprove: false },
      limits: { requestsPerMinutePerClient: 30, textMaxChars: 2000 },
    });
    expect(typeof m.tagline).toBe("string");
    expect(m.authority.note).toContain("CLEARING_AGENT_CAN_APPROVE=true");
    expect(m.endpoints.map((e: Json) => `${e.method} ${e.path}`)).toEqual([
      "GET /api/agent",
      "POST /api/agent/request",
      "POST /api/agent/confirm",
      "GET /api/agent/plan",
      "POST /api/agent/approve",
    ]);
    for (const e of m.endpoints) {
      expect(Array.isArray(e.input)).toBe(true);
      expect(e.output.length).toBeGreaterThan(0);
    }
    const request = m.endpoints.find((e: Json) => e.path === "/api/agent/request");
    expect(request.input.map((f: Json) => f.name)).toEqual(["text", "eventDate", "timezone", "nowLocal", "venueName", "idempotencyKey"]);
    expect(request.input.filter((f: Json) => f.required).map((f: Json) => f.name)).toEqual(["text", "idempotencyKey"]);
  });

  it("reports agentCanApprove only when the flag is exactly \"true\"", async () => {
    process.env.CLEARING_AGENT_CAN_APPROVE = "true";
    expect((await read(await manifestGet(get()))).authority.agentCanApprove).toBe(true);
    process.env.CLEARING_AGENT_CAN_APPROVE = "yes";
    expect((await read(await manifestGet(get()))).authority.agentCanApprove).toBe(false);
  });
});

describe("POST /api/agent/request", () => {
  it("accepts the preset text: nothing missing, next action is confirm, defaults are reported", async () => {
    const { res, body } = await sendRequest(PRESET_TEXT);
    expect(res.status).toBe(200);
    expect(body.phase).toBe("confirming");
    expect(body.nextAction).toBe("confirm");
    expect(body.requirements.missing).toEqual([]);
    expect(body.requirements.confirmed).toEqual(expect.arrayContaining(["headcount", "vegetarianMin", "readyBy", "budget", "drinks", "plates", "utensils"]));
    expect(body.requirements.assumed.map((a: Json) => a.field)).toContain("venue");
    expect(body.requirements.assumed.every((a: Json) => typeof a.note === "string" && a.note.length > 0)).toBe(true);
    expect(body.requirements.values).toMatchObject({ headcount: 60, vegetarianMin: 20, readyByLocal: "18:30", budgetCents: 100_000, timezone: "America/Los_Angeles", nowLocal: "14:00" });
    // The injected clock is Friday 2026-10-16, so the next demo Friday (>= 3 days out) is a week later.
    expect(body.assumptionsApplied).toEqual([
      expect.objectContaining({ field: "timezone", value: "America/Los_Angeles" }),
      expect.objectContaining({ field: "eventDate", value: "2026-10-23" }),
      expect.objectContaining({ field: "nowLocal", value: "14:00" }),
    ]);
    expect(typeof body.runId).toBe("string");
  });

  it("applies no defaults for fields the caller supplied", async () => {
    const { body } = await sendRequest(PRESET_TEXT, { eventDate: "2026-11-06", timezone: "America/New_York", nowLocal: "13:15", venueName: "Pier 9 Hall" });
    expect(body.assumptionsApplied).toEqual([]);
    expect(body.requirements.values).toMatchObject({ eventDate: "2026-11-06", timezone: "America/New_York", nowLocal: "13:15", venue: "Pier 9 Hall" });
    expect(body.requirements.assumed.map((a: Json) => a.field)).not.toContain("venue");
  });

  it("flags a missing budget as fix_missing and tells the agent how to fix it", async () => {
    const { res, body } = await sendRequest(REQUESTS.noBudget.text);
    expect(res.status).toBe(200);
    expect(body.nextAction).toBe("fix_missing");
    expect(body.requirements.missing).toEqual(["budget"]);
    expect(body.requirements.values.budgetCents).toBeNull();
    expect(body.requirements.howToFix.budget).toContain("edits.budgetCents");

    // Confirming without the budget is refused; confirming with it opens the market.
    const refused = await confirmPost(post("/confirm", { idempotencyKey: KEY("confirm-a") }));
    expect(refused.status).toBe(400);
    expect((await read(refused)).error).toMatchObject({ code: "missing_requirements", details: { missing: ["budget"] } });
    const ok = await confirmPost(post("/confirm", { edits: { budgetCents: 100_000 }, idempotencyKey: KEY("confirm-b") }));
    expect(ok.status).toBe(200);
    expect(await read(ok)).toMatchObject({ runId: body.runId, phase: "collecting" });
  });

  it("is idempotent by key: a replay returns the same run without re-versioning the request", async () => {
    const first = await sendRequest(PRESET_TEXT, {}, "same");
    const versionAfterFirst = service.getRun(first.body.runId)!.requestVersion;
    const second = await sendRequest(PRESET_TEXT, {}, "same");
    expect(second.body).toEqual(first.body);
    expect(service.getRun(first.body.runId)!.requestVersion).toBe(versionAfterFirst);
    await sendRequest(PRESET_TEXT, {}, "different");
    expect(service.getRun(first.body.runId)!.requestVersion).toBe(versionAfterFirst + 1);
  });

  it("rejects text over 2000 characters with a 400 validation error", async () => {
    const { res, body } = await sendRequest("x".repeat(2001));
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(JSON.stringify(body.error.details)).toContain("text");
    expect((await sendRequest("x".repeat(2000))).res.status).toBe(200);
  });

  it("rejects bad input: unknown keys, short idempotency key, bad timezone, bad JSON", async () => {
    const unknown = await requestPost(post("/request", { text: PRESET_TEXT, budget: 500, idempotencyKey: KEY("u") }));
    expect(unknown.status).toBe(400);
    expect(JSON.stringify((await read(unknown)).error.details)).toContain("budget");

    const shortKey = await requestPost(post("/request", { text: PRESET_TEXT, idempotencyKey: "short" }));
    expect(shortKey.status).toBe(400);

    const badZone = await sendRequest(PRESET_TEXT, { timezone: "Mars/Olympus" }, "zone");
    expect(badZone.res.status).toBe(400);
    expect(badZone.body.error.code).toBe("invalid_timezone");

    const badJson = await requestPost(post("/request", "{not json"));
    expect(badJson.status).toBe(400);
    expect((await read(badJson)).error.code).toBe("invalid_json");
  });

  it("treats injected instructions in the text as data: the budget still comes from the stated budget", async () => {
    const { body } = await sendRequest(REQUESTS.injection.text);
    expect(body.nextAction).toBe("confirm");
    expect(body.requirements.values.budgetCents).toBe(100_000);
  });
});

describe("GET /api/agent/plan", () => {
  it("has no plan before the market opens", async () => {
    await sendRequest(PRESET_TEXT);
    const body = await read(await planGet(get("/plan")));
    expect(body).toMatchObject({ phase: "confirming", nextAction: "confirm", plan: null, infeasibility: null });
    expect(body.labels).toEqual({ coordination: "Local transport", supply: "Fictional demo catalog", reasoning: "Local rules", execution: "Simulated orders" });
  });

  it("reads the compact proposed plan once the market has cleared", async () => {
    const run = await proposedPreset();
    const res = await planGet(get("/plan"));
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.runId).toBe(run.id);
    expect(body.phase).toBe("proposed");
    expect(body.nextAction).toBe("await_organizer_approval");
    expect(body.infeasibility).toBeNull();
    expect(body.plan).toMatchObject({
      revision: run.currentPlanRevision,
      status: "proposed",
      totalCents: EXPECTED.clearedTotalCents,
      slackMinutes: EXPECTED.clearedSlackMinutes,
      remainingCents: 100_000 - EXPECTED.clearedTotalCents,
      approvalRequired: true,
      unresolvedConditions: expect.any(Array),
    });
    expect(body.plan.selections.map((s: Json) => s.merchant).sort()).toEqual(["Bodega Marquez", "Golden Hour Taqueria", "Pelican Couriers"]);
    for (const s of body.plan.selections) {
      expect(Object.keys(s).sort()).toEqual(["change", "group", "merchant", "totalCents"]);
    }
    // Compact view: no seller policy, no merchant free text.
    expect(JSON.stringify(body)).not.toMatch(/policy|floorPct|description/i);
  });

  it("reports the honest infeasibility, with the budget gap, when no plan fits", async () => {
    await sendRequest(REQUESTS.impossibleBudget.text);
    const confirmed = await confirmPost(post("/confirm", { idempotencyKey: KEY("confirm") }));
    await service.drain((await read(confirmed)).runId);
    const body = await read(await planGet(get("/plan")));
    expect(body.phase).toBe("no_feasible_plan");
    expect(body.nextAction).toBe("revise_request");
    expect(body.plan).toBeNull();
    expect(body.infeasibility).toMatchObject({ kind: "over_budget", summary: expect.any(String) });
    expect(body.infeasibility.budgetGapCents).toBeGreaterThan(0);
    expect(body.infeasibility.cheapestMerchants.length).toBeGreaterThan(0);
  });
});

describe("POST /api/agent/approve", () => {
  it("returns 403 approval_requires_organizer by default, and changes nothing", async () => {
    const run = await proposedPreset();
    const res = await approvePost(post("/approve", { planRevision: run.currentPlanRevision, idempotencyKey: KEY("approve") }));
    expect(res.status).toBe(403);
    const body = await read(res);
    expect(body.error.code).toBe("approval_requires_organizer");
    expect(typeof body.error.message).toBe("string");
    const after = service.getRun(run.id)!;
    expect(after.phase).toBe("proposed");
    expect(after.orders).toEqual([]);
    expect(after.approvals).toEqual([]);
  });

  it("stays 403 for flag values other than exactly \"true\"", async () => {
    for (const v of ["1", "TRUE", "yes", ""]) {
      process.env.CLEARING_AGENT_CAN_APPROVE = v;
      const res = await approvePost(post("/approve", { planRevision: 1, idempotencyKey: KEY("approve") }));
      expect(res.status).toBe(403);
    }
  });

  it("delegates to the same service approve when the operator enables it, idempotently", async () => {
    process.env.CLEARING_AGENT_CAN_APPROVE = "true";
    const run = await proposedPreset();
    expect((await read(await planGet(get("/plan")))).nextAction).toBe("approve");
    const cmd = { planRevision: run.currentPlanRevision, idempotencyKey: KEY("approve-ok") };
    const res = await approvePost(post("/approve", cmd));
    expect(res.status).toBe(200);
    const approved = (await read(res)).run;
    expect(approved.phase).toBe("simulated_confirmed");
    expect(approved.orders).toHaveLength(3);
    expect(approved.orders.every((o: Json) => o.simulated === true)).toBe(true);

    const replay = await approvePost(post("/approve", cmd));
    expect(replay.status).toBe(200);
    expect(service.getRun(run.id)!.orders).toHaveLength(3);
    expect(service.getRun(run.id)!.approvals).toHaveLength(1);

    const plan = await read(await planGet(get("/plan")));
    expect(plan.phase).toBe("simulated_confirmed");
    expect(plan.plan).toMatchObject({ status: "approved", approvalRequired: false });
  });

  it("surfaces the service's error for an unknown plan revision when enabled", async () => {
    process.env.CLEARING_AGENT_CAN_APPROVE = "true";
    const run = await proposedPreset();
    const res = await approvePost(post("/approve", { planRevision: (run.currentPlanRevision ?? 1) + 5, idempotencyKey: KEY("approve-stale") }));
    expect(res.status).toBe(404);
    expect((await read(res)).error.code).toBe("not_found");
  });
});

describe("rate limit", () => {
  it("allows 30 requests per minute per client, then answers 429 with Retry-After", async () => {
    expect(RATE_LIMIT_PER_MINUTE).toBe(30);
    for (let i = 0; i < 30; i++) {
      const res = await manifestGet(get("", { "x-forwarded-for": "203.0.113.7" }));
      expect(res.status).toBe(200);
    }
    const limited = await manifestGet(get("", { "x-forwarded-for": "203.0.113.7" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await read(limited)).error.code).toBe("rate_limited");

    // Every /api/agent route shares the client's bucket; other clients are unaffected.
    const planLimited = await planGet(get("/plan", { "x-forwarded-for": "203.0.113.7" }));
    expect(planLimited.status).toBe(429);
    const postLimited = await requestPost(post("/request", { text: PRESET_TEXT, idempotencyKey: KEY("rl") }, { "x-forwarded-for": "203.0.113.7" }));
    expect(postLimited.status).toBe(429);
    expect((await manifestGet(get("", { "x-forwarded-for": "198.51.100.9" }))).status).toBe(200);
    // Requests without the header share the "local" bucket.
    expect((await manifestGet(get())).status).toBe(200);
  });

  it("uses the first x-forwarded-for entry as the client key", async () => {
    for (let i = 0; i < 30; i++) await manifestGet(get("", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));
    expect((await manifestGet(get("", { "x-forwarded-for": "203.0.113.7, 10.0.0.2" }))).status).toBe(429);
    expect((await manifestGet(get("", { "x-forwarded-for": "10.0.0.1" }))).status).toBe(200);
  });
});
