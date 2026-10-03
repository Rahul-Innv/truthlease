/** Integer-cent arithmetic and formatting. */

export function formatCents(cents: number, opts: { sign?: boolean } = {}): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = `$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
  if (negative) return `−${body}`;
  return opts.sign ? `+${body}` : body;
}

/** Percentage of an integer amount, rounded half-up to the cent. */
export function pctOf(cents: number, pct: number): number {
  return Math.round((cents * pct) / 100);
}

/** Apply a percentage discount to a unit price, never below the floor. */
export function discountedUnit(listCents: number, discountPct: number, floorPctOfList: number): number {
  const proposed = Math.round((listCents * (100 - discountPct)) / 100);
  const floor = Math.ceil((listCents * floorPctOfList) / 100);
  return Math.max(proposed, floor);
}

export function parseDollarsToCents(text: string): number | null {
  const m = /\$?\s*([\d,]+(?:\.\d{1,2})?)/.exec(text);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
