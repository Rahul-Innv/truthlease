import { describe, expect, it } from "vitest";
import { localDiscovery } from "@/lib/discovery/local";
import { tavilyWebDiscovery, withWebDiscovery } from "@/lib/discovery/tavily";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    expect(String((init?.headers as Record<string, string>)?.authorization)).toMatch(/^Bearer /);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("Tavily web discovery", () => {
  it("maps results to non-executable candidates with url and retrieval time", async () => {
    const p = tavilyWebDiscovery({ apiKey: "tvly-test", fetchImpl: fakeFetch(200, { results: [{ title: "Bay Area Catering Co", url: "https://example.test/catering", content: "...", score: 0.81 }, { title: "no url", content: "x" }] }) });
    const r = await p.discover("dinner for 60", { topK: 5, zone: "bayfront" });
    expect(r.engine).toBe("tavily");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ id: "web:1", executable: false, score: 0.81 });
    expect(r.candidates[0]!.note).toContain("https://example.test/catering");
    expect(r.candidates[0]!.note).toContain("not a quote");
    expect(p.status().connected).toBe(true);
  });

  it("reports failures without ever marking connected", async () => {
    const p = tavilyWebDiscovery({ apiKey: "tvly-test", fetchImpl: fakeFetch(401, { error: "unauthorized" }) });
    await expect(p.discover("x", { topK: 3, zone: "bayfront" })).rejects.toThrow(/401/);
    expect(p.status()).toMatchObject({ connected: false });
    expect(p.status().note).toContain("401");
  });

  it("composite keeps the directory engine authoritative and appends web results as non-executable", async () => {
    const web = tavilyWebDiscovery({ apiKey: "tvly-test", fetchImpl: fakeFetch(200, { results: [{ title: "Some Caterer", url: "https://example.test/a", score: 0.5 }] }) });
    const composite = withWebDiscovery(localDiscovery(), web);
    const r = await composite.discover("Dinner for 60 attendees, 20 vegetarian, drinks plates utensils, bayfront", { topK: 10, zone: "bayfront" });
    expect(r.engine).toBe("local-keyword");
    expect(r.web).toMatchObject({ engine: "tavily", count: 1, ok: true });
    expect(r.candidates.some((c) => c.executable)).toBe(true);
    expect(r.candidates.filter((c) => c.id.startsWith("web:")).every((c) => !c.executable)).toBe(true);
    const failing = withWebDiscovery(localDiscovery(), tavilyWebDiscovery({ apiKey: "k", fetchImpl: fakeFetch(500, {}) }));
    const r2 = await failing.discover("dinner", { topK: 10, zone: "bayfront" });
    expect(r2.web).toMatchObject({ engine: "tavily", ok: false });
    expect(r2.candidates.length).toBeGreaterThan(0);
  });
});
