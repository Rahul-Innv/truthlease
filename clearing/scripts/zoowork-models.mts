/** List selectable ZooWork models (read-only; needs ZOOWORK_API_KEY). Never prints the key. */
const sdk = await import("@zoowork-ai/sdk");
if (!process.env.ZOOWORK_API_KEY) {
  console.error("Set ZOOWORK_API_KEY first.");
  process.exit(2);
}
const zc = sdk.createZooworkClient({ apiKey: process.env.ZOOWORK_API_KEY });
const models = await zc.listModels();
for (const m of models) console.log(`${m.selectable === false ? "  (not selectable) " : "  "}${m.model}${m.default_for?.length ? `  default_for=${m.default_for.join(",")}` : ""}`);
