import React, { useEffect } from "react";
import { act, render, screen } from "./testing.cjs";
import { LazyChartPreview } from "./LazyChartPreview.tsx";

const originalObserver = globalThis.IntersectionObserver;
let callback: IntersectionObserverCallback;
let targets: Set<Element>;
let observers: number;
let disconnects: number;

beforeEach(() => {
  targets = new Set();
  observers = 0;
  disconnects = 0;
  globalThis.IntersectionObserver = class {
    constructor(cb: IntersectionObserverCallback, options: IntersectionObserverInit) {
      callback = cb;
      observers += 1;
      expect(options.rootMargin).toBe("300px 0px");
    }
    observe(target: Element) { targets.add(target); }
    unobserve(target: Element) { targets.delete(target); }
    disconnect() { targets.clear(); disconnects += 1; }
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  globalThis.IntersectionObserver = originalObserver;
});

function intersect(target: Element, isIntersecting = true) {
  act(() => callback(
    [{ target, isIntersecting } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  ));
}

describe("lazy chart previews", () => {
  it("mounts only nearby charts on a 200-row, two-preview page", () => {
    let mounts = 0;
    function Chart() {
      useEffect(() => { mounts += 1; }, []);
      return <span>Drawn chart</span>;
    }
    const view = render(<>
      {Array.from({ length: 400 }, (_, i) => (
        <LazyChartPreview key={i} width={246} height={110}><Chart /></LazyChartPreview>
      ))}
    </>);
    expect(mounts).toBe(0);
    expect(targets.size).toBe(400);
    expect(observers).toBe(1);
    const [first, second] = [...targets];
    expect((first as HTMLElement).style.minHeight).toBe("110px");
    expect((first as HTMLElement).style.width).toBe("246px");

    intersect(first, false);
    expect(mounts).toBe(0);
    intersect(first);
    intersect(second);
    expect(mounts).toBe(2);
    expect(screen.getAllByText("Drawn chart")).toHaveLength(2);
    expect(targets.size).toBe(398);
    // Leaving and reentering the viewport must not remount the chart.
    intersect(first, false);
    intersect(first);
    expect(mounts).toBe(2);

    view.unmount();
    expect(targets.size).toBe(0);
    expect(disconnects).toBeGreaterThan(0);
  });

  it("disconnects after loading and observes new previews on the next page", () => {
    const first = render(
      <LazyChartPreview width={246} height={110}><span>First chart</span></LazyChartPreview>,
    );
    intersect([...targets][0]);
    expect(screen.getByText("First chart")).toBeTruthy();
    expect(disconnects).toBe(1);
    first.unmount();

    const second = render(
      <LazyChartPreview width={246} height={110}><span>Next chart</span></LazyChartPreview>,
    );
    expect(screen.queryByText("Next chart")).toBeNull();
    expect(observers).toBe(2);
    intersect([...targets][0]);
    expect(screen.getByText("Next chart")).toBeTruthy();
    second.unmount();
  });

  it("renders charts normally when IntersectionObserver is unavailable", () => {
    // Reflect preserves the DOM type while simulating an older browser.
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
    const view = render(
      <LazyChartPreview width={246} height={110}><span>Fallback chart</span></LazyChartPreview>,
    );
    expect(screen.getByText("Fallback chart")).toBeTruthy();
    expect(observers).toBe(0);
    view.unmount();
  });
});
