/**
 * Browser-runtime builds only (aliased in next.config.ts for the `browser`
 * condition when NEXT_PUBLIC_CLEARING_RUNTIME=browser): stands in for
 * `node:fs` and `node:path`, which `store.ts` imports at module level for the
 * SQLite store. The page imports `store.ts` only for the shared error classes;
 * nothing here is ever called in the browser, and calling it fails loudly.
 */
function unavailable(name: string): never {
  throw new Error(`${name} is not available in the browser runtime (no filesystem).`);
}

export const mkdirSync = (): never => unavailable("node:fs.mkdirSync");
export const existsSync = (): never => unavailable("node:fs.existsSync");
export const readFileSync = (): never => unavailable("node:fs.readFileSync");
export const writeFileSync = (): never => unavailable("node:fs.writeFileSync");

const path = {
  resolve: (): never => unavailable("node:path.resolve"),
  dirname: (): never => unavailable("node:path.dirname"),
  join: (): never => unavailable("node:path.join"),
};
export default path;
