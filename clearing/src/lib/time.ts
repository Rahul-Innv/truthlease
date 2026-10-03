/** Local wall-clock helpers. Times are "HH:MM" on the event date. */

export function toMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid local time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function addMinutes(hhmm: string, delta: number): string {
  return fromMinutes(toMinutes(hhmm) + delta);
}

/** "18:30" → "6:30 PM" for display. */
export function formatLocal(hhmm: string): string {
  const total = toMinutes(hhmm);
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Parse "6:30 PM", "6pm", "18:30" into "HH:MM". Returns null when unparseable. */
export function parseLooseTime(text: string): string | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && h < 8) h += 12; // "6:30" with no suffix for an evening event is 18:30
  if (h > 23 || min > 59) return null;
  return fromMinutes(h * 60 + min);
}

/** Next Friday at least 3 days out, as YYYY-MM-DD in the given IANA zone. */
export function nextDemoEventDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = Number(get("year"));
  const mo = Number(get("month"));
  const d = Number(get("day"));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  let delta = (5 - weekday + 7) % 7;
  if (delta < 3) delta += 7;
  const target = new Date(Date.UTC(y, mo - 1, d + delta));
  return target.toISOString().slice(0, 10);
}
