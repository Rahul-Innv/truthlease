import { describe, expect, it } from "vitest";
import { liveProvider, type LiveTransport, type TransportCall } from "@/lib/providers/live";
import { localProvider } from "@/lib/providers/local";
import { PRESET_TEXT } from "@/lib/fixtures";
import type { CounterRequest } from "@/lib/buyer";
import type { Offer } from "@/lib/contracts";

function transport(impl: <T>(call: TransportCall<T>) => Promise<T | null>, name = "fake"): LiveTransport {
  return { name, parse: impl };
}

const asks: CounterRequest[] = [
  { offerId: "off_a_v1", merchantId: "m-a", lever: "earlier_slot", ask: "earlier please" },
  { offerId: "off_b_v1", merchantId: "m-b", lever: "volume_discount", ask: "discount?" },
];

const offer: Offer = {
  id: "off_a_v1", merchantId: "m-a", merchantName: "A", group: "meals", revision: 1, status: "open", requestVersion: 1,
  lines: [{ sku: "x", label: "x", kind: "meal_standard", qty: 1, unitCents: 100, lineCents: 100 }], fees: [], deliveryCents: null, totalCents: 100,
  fulfillment: { mode: "pickup_only", slotId: "s", timeLocal: "17:00" }, expiresAt: "2026-10-17T00:00:00.000Z", conditions: [], unpriced: [],
  provenance: { supply: "demo_catalog", reasoning: "local", round: 0, note: "" }, createdAt: "2026-10-16T21:00:00.000Z",
};

describe("local provider", () => {
  it("uses zero model calls and deterministic extraction", async () => {
    const p = localProvider();
    const r = await p.interpret(PRESET_TEXT);
    expect(r.reasoning).toBe("local");
    expect(r.value.headcount).toBe(60);
    expect(p.callsUsed()).toBe(0);
  });
});

describe("live provider bounded handling", () => {
  it("falls back to local rules on schema-invalid output after one repair attempt", async () => {
    const events: string[] = [];
    let n = 0;
    const p = liveProvider({ transport: transport(async () => { n++; return { garbage: true } as never; }), onEvent: (e) => events.push(e.type) });
    const r = await p.interpret(PRESET_TEXT);
    expect(n).toBe(2);
    expect(r.reasoning).toBe("local");
    expect(r.fallback?.reason).toContain("schema");
    expect(r.value.headcount).toBe(60);
    expect(events.filter((e) => e === "model.fallback")).toHaveLength(1);
  });

  it("falls back on timeout without hanging", async () => {
    const p = liveProvider({ timeoutMs: 30, transport: transport((call) => new Promise((_, reject) => { call.signal.addEventListener("abort", () => reject(new Error("aborted"))); })) });
    const started = Date.now();
    const r = await p.interpret(PRESET_TEXT);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.reasoning).toBe("local");
    expect(r.fallback?.reason).toBe("timeout");
  });

  it("falls back on provider errors and labels rate limits", async () => {
    const p = liveProvider({ transport: transport(async () => { throw Object.assign(new Error("429"), { status: 429 }); }) });
    const r = await p.chooseAsks(asks, { round: 1 });
    expect(r.reasoning).toBe("local");
    expect(r.value).toEqual(asks);
    expect(r.fallback?.reason).toContain("429");
  });

  it("respects the total call ceiling", async () => {
    const p = liveProvider({ maxCalls: 3, transport: transport(async () => { throw new Error("boom"); }) });
    await p.interpret("one");
    await p.interpret("two");
    expect(p.callsUsed()).toBe(3);
    const r = await p.interpret("three");
    expect(r.fallback?.reason).toContain("call budget");
    expect(p.callsUsed()).toBe(3);
  });

  it("never lets the model invent asks or levers", async () => {
    const p = liveProvider({ transport: transport(async () => ({ suggestions: [
      { offerRef: "off_b_v1", lever: "volume_discount", reason: "price first" },
      { offerRef: "off_zzz", lever: "earlier_slot", reason: "invented" },
      { offerRef: "off_a_v1", lever: "later_pickup", reason: "wrong lever" },
    ] }) as never) });
    const r = await p.chooseAsks(asks, { round: 1 });
    expect(r.reasoning).toBe("live");
    expect(r.value.map((a) => a.offerId)).toEqual(["off_b_v1"]);
  });

  it("caps concurrency and aborts superseded work", async () => {
    let inFlight = 0;
    let peak = 0;
    const p = liveProvider({ maxConcurrent: 2, maxCalls: 50, transport: transport(async (call) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { lever: "earlier_slot", reason: "ok" } as never;
    }) });
    await Promise.all([1, 2, 3, 4, 5].map((i) => p.chooseSellerLever({ ...offer, id: `o${i}`, totalCents: i }, "volume_discount")));
    expect(peak).toBeLessThanOrEqual(2);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await p.chooseSellerLever({ ...offer, id: "stale" }, "volume_discount", ctrl.signal);
    expect(r.reasoning).toBe("local");
    expect(r.fallback?.reason).toContain("aborted");
  });
});
