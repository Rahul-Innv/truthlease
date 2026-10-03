"use client";
import { useEffect, useRef, useState } from "react";

/** Tracks an element's content width with a ResizeObserver. */
export function useElementWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth((prev) => (Math.abs(w - prev) >= 1 ? Math.round(w) : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
