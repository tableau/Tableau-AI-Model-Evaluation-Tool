import React, { useEffect, useRef, useState } from "react";

// Share one observer across both preview columns, even on a 200-row page.
const waiting = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

function observePreview(element: Element, reveal: () => void): () => void {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const load = waiting.get(entry.target);
        waiting.delete(entry.target);
        observer?.unobserve(entry.target);
        load?.();
      }
      if (waiting.size === 0) {
        observer?.disconnect();
        observer = null;
      }
    }, { rootMargin: "300px 0px" });
  }
  waiting.set(element, reveal);
  observer.observe(element);
  return () => {
    waiting.delete(element);
    observer?.unobserve(element);
    if (waiting.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/** Defer chart compilation and drawing, not just painting an offscreen chart.
 * Once revealed, keep the chart mounted so scrolling back does not redraw it. */
export function LazyChartPreview({ children, width, height }: {
  children: React.ReactNode;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Older browsers still get previews rather than permanent placeholders.
    if (typeof IntersectionObserver === "undefined") {
      setLoaded(true);
      return;
    }
    if (ref.current) return observePreview(ref.current, () => setLoaded(true));
  }, []);

  return (
    <div ref={ref} style={{ width, maxWidth: "100%", minHeight: height }}>
      {loaded ? children : (
        <div
          role="img"
          aria-label="Chart preview loads when scrolled into view"
          style={{ height, background: "#fafafa", borderRadius: 4 }}
        />
      )}
    </div>
  );
}
