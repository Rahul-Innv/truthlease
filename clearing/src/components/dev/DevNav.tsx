import Link from "next/link";

export function DevNav({ states, current }: { states: readonly string[]; current: string }) {
  return (
    <nav aria-label="Dev sample variants" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-line bg-surface px-4 py-1.5 text-xs">
      <span className="font-medium text-amber">Dev sample · static data · commands disabled</span>
      <span className="text-muted">Variant:</span>
      {states.map((s) => (
        <Link
          key={s}
          href={`/dev?state=${s}`}
          aria-current={s === current ? "page" : undefined}
          className={s === current ? "font-medium text-text underline underline-offset-4" : "text-accent hover:underline"}
        >
          {s}
        </Link>
      ))}
      <Link href="/" className="ml-auto text-accent hover:underline">
        Live console →
      </Link>
    </nav>
  );
}
