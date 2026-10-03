/**
 * Small presentational primitives. State is always carried by text plus a
 * shape glyph; colour only reinforces it.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Glyph as GlyphName, Tone } from "./format";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  mint: "text-mint",
  amber: "text-amber",
  red: "text-red",
  accent: "text-accent",
};

const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-line bg-surface-2 text-muted",
  mint: "border-mint/35 bg-mint/10 text-mint",
  amber: "border-amber/35 bg-amber/10 text-amber",
  red: "border-red/40 bg-red/10 text-red",
  accent: "border-accent/35 bg-accent/10 text-accent",
};

export function toneText(t: Tone): string {
  return TONE_TEXT[t];
}

/** 12px shape glyphs. Each state has a distinct silhouette, not just a colour. */
export function Glyph({ name, className }: { name: GlyphName; className?: string }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true, className: cx("shrink-0", className) } as const;
  switch (name) {
    case "dot":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4" fill="currentColor" />
        </svg>
      );
    case "ring":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "half":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.75 A4.25 4.25 0 0 1 6 10.25 Z" fill="currentColor" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M2.5 6.4 L5 8.8 L9.6 3.4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cross":
      return (
        <svg {...common}>
          <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      );
    case "warn":
      return (
        <svg {...common}>
          <path d="M6 1.5 L10.8 10 H1.2 Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M6 4.6 V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="6" cy="8.6" r="0.75" fill="currentColor" />
        </svg>
      );
    case "dash":
      return (
        <svg {...common}>
          <path d="M2.5 6 H9.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M6 2.5 V9.5 M2.5 6 H9.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      );
    case "swap":
      return (
        <svg {...common}>
          <path d="M2 4 H9 L7.2 2.2 M10 8 H3 L4.8 9.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 3.6 V6 L7.8 7.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
  }
}

export function Chip({
  tone = "neutral",
  glyph,
  pulse,
  children,
  className,
  title,
}: {
  tone?: Tone;
  glyph?: GlyphName;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-xs font-medium leading-none", TONE_CHIP[tone], className)}
    >
      {glyph ? <Glyph name={glyph} className={pulse ? "pulse" : undefined} /> : null}
      {children}
    </span>
  );
}

/** Linear-style group header bar: title, count, optional trailing slot. */
export function SectionHeader({ title, count, children, id }: { title: string; count?: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="flex min-h-9 items-center gap-2 border-y border-line bg-surface-2/60 px-4 py-1.5">
      <h2 id={id} className="text-[13px] font-semibold text-text">
        {title}
      </h2>
      {count !== undefined ? <span className="num text-xs text-muted">{count}</span> : null}
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-mint text-ink hover:bg-mint/90 disabled:bg-surface-2 disabled:text-muted disabled:border-line border border-mint",
  secondary: "border border-line bg-surface-2 text-text hover:border-muted/60 disabled:text-muted",
  ghost: "border border-transparent text-muted hover:text-text hover:bg-surface-2 disabled:text-muted/70",
  danger: "border border-red/50 bg-red/10 text-red hover:bg-red/20 disabled:text-muted disabled:border-line disabled:bg-transparent",
};

export function Button({ variant = "secondary", size = "md", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        BUTTON_VARIANT[variant],
        className,
      )}
    />
  );
}

/** Label/value row (Linear profile panel). */
export function KV({ label, children, emphasis, hint }: { label: ReactNode; children: ReactNode; emphasis?: boolean; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[13px] text-muted">
        {label}
        {hint ? <span className="ml-1 text-xs text-muted">{hint}</span> : null}
      </dt>
      <dd className={cx("num text-right text-sm", emphasis ? "font-semibold text-text" : "text-text")}>{children}</dd>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-xs text-muted">{children}</kbd>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-5">
      <p className="text-sm font-medium text-text">{title}</p>
      {children ? <div className="mt-1 text-[13px] leading-relaxed text-muted">{children}</div> : null}
    </div>
  );
}
