/**
 * The tool's own chart metrics (stage `vizQuality`), one rule per test.
 */
import { describe, expect, test } from "bun:test";
import {
  computeToolMetrics as compute,
  describeSpec,
  fieldSimilarity,
  filterAccuracy,
  NO_FIELDS_EXPLANATION,
  NO_SPEC_EXPLANATION,
  type ComputedVizMetric,
  type Field,
} from "./viz.ts";

function field(
  caption: string,
  enc: string | null = null,
  { role = "dimension", data = "string", agg = null as string | null, ...extra }: Record<string, unknown> = {},
): Field {
  const f: Field = { caption, role, data };
  if (enc) f.encoding = enc;
  if (agg) f.aggregation = agg;
  return { ...f, ...extra };
}

const spec = (fields: Field[], chart = "bar", extra: Record<string, unknown> = {}) => ({
  notionalSpec: { version: "0.1.0", chart, fields, ...extra },
});

const SALES = field("Sales", "y", { role: "measure", data: "number", agg: "sum" });
const REGION = field("Region", "x");
const EXPECTED = spec([REGION, SALES]);

const byName = (entries: ComputedVizMetric[]) =>
  Object.fromEntries(entries.map((e) => [e.metric_name, e])) as Record<string, ComputedVizMetric>;

const CHART_METRICS = [
  "chartSimilarity",
  "fieldSimilarity",
  "filterAccuracy",
  "sortAccuracy",
  "axisAccuracy",
  "aestheticAccuracy",
  "tooltipAccuracy",
];

test("no expected chart is not scored", () => {
  const answer = spec([field("Region", "x"), SALES]);
  expect(compute({ intent: "NLQ_TO_NOTIONAL_SPEC", notionalSpec: null }, answer)).toEqual([]);
  expect(compute({ intent: "NLQ_TO_NEW_CALCULATED_FIELD" }, answer)).toEqual([]);
  expect(compute(null, answer)).toEqual([]);
});

test("no answer chart scores zero everywhere", () => {
  const m = byName(compute(EXPECTED, { notionalSpec: null }));
  for (const name of CHART_METRICS) {
    expect(m[name]!.score).toBe(0.0);
    expect(m[name]!.explanation).toBe(NO_SPEC_EXPLANATION);
  }
});

test("a chart with no fields is no chart, but its filter still counts", () => {
  const filters = [{ type: "categorical", field: "Region", values: ["West"] }];
  const m = byName(
    compute(spec([REGION, SALES], "bar", { categoricalFilters: filters }), spec([], "text", { categoricalFilters: filters })),
  );
  expect(m.filterAccuracy!.score).toBe(1.0);
  for (const name of CHART_METRICS.filter((n) => n !== "filterAccuracy")) {
    expect(m[name]!.score).toBe(0.0);
    expect(m[name]!.explanation).toBe(NO_FIELDS_EXPLANATION);
  }
});

test("swapped axes are not penalized and the explanation says so", () => {
  const swapped = spec([field("Region", "y"), field("Sales", "x", { role: "measure", data: "number", agg: "sum" })]);
  const m = byName(compute(EXPECTED, swapped));
  expect(m.fieldSimilarity!.score).toBe(1.0);
  expect(m.fieldSimilarity!.explanation).toContain("swapped");
  expect(m.fieldSimilarity!.explanation).toContain("not penalized");
  expect(m.axisAccuracy!.score).toBe(1.0);
  expect(m.axisAccuracy!.explanation).toContain("swapped");
});

test("a similar name is not a match", () => {
  const m = byName(
    compute(spec([field("Created Date", "x", { data: "date" }), SALES]), spec([field("Close Date", "x", { data: "date" }), SALES])),
  );
  expect(m.fieldSimilarity!.score).toBeCloseTo(1 / 3, 12);
  expect(m.fieldSimilarity!.explanation).toContain("missing: Created Date");
  expect(m.fieldSimilarity!.explanation).toContain("extra: Close Date");
  expect(m.fieldSimilarity!.explanation).toContain("similar name is not a match");
});

test("every channel counts for field similarity", () => {
  const expected = spec([REGION, SALES, field("Category", "color")]);
  const m = byName(compute(expected, spec([REGION, SALES, field("Segment", "color")])));
  expect(m.fieldSimilarity!.score).toBeCloseTo(2 / 4, 12);
  expect(m.fieldSimilarity!.explanation).toContain("Category");
  expect(m.fieldSimilarity!.explanation).toContain("Segment");
  const same = byName(compute(expected, expected));
  expect(same.fieldSimilarity!.explanation).toBe(
    "Every field matches by name on every channel: Region, Sales (sum), Category.",
  );
});

test("a wildcard caption matches any field of the same kind", () => {
  const expected = spec(
    [SALES, field("Expected Revenue", "y", { role: "measure", data: "number", agg: "sum", _tb_wildcards: ["caption"] })],
    "scatterplot",
  );
  const answer = spec([SALES, field("Amount", "y", { role: "measure", data: "number", agg: "sum" })], "scatterplot");
  expect(fieldSimilarity(expected.notionalSpec, answer.notionalSpec)).toBe(1.0);
  const wrongKind = spec([SALES, field("Region", "y")], "scatterplot");
  expect(fieldSimilarity(expected.notionalSpec, wrongKind.notionalSpec)).toBeCloseTo(1 / 3, 12);
});

test("single-axis charts score without crashing", () => {
  const kpi = spec([field("Sales", null, { role: "measure", data: "number", agg: "sum" })], "text");
  const m = byName(compute(kpi, kpi));
  expect(m.axisAccuracy!.score).toBe(1.0);
  expect(m.axisAccuracy!.explanation!.startsWith("Axis fields match")).toBe(true);
  expect(m.fieldSimilarity!.score).toBe(1.0);
});

describe("every kind of filter counts", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>, number][] = [
    [
      "categoricalFilters",
      { type: "categorical", field: "Region", values: ["West", "East"] },
      { type: "categorical", field: "region", values: ["east", "West"], limit: 10 },
      1.0,
    ],
    [
      "dateRangeFilters",
      { type: "date-range", field: "Close Date", start: "2026-03-01", end: "2026-06-30" },
      { type: "date-range", field: "Close Date", start: "2026-03-01", end: "2026-06-30" },
      1.0,
    ],
    [
      "dateRangeFilters",
      { type: "date-range", field: "Close Date", end: "2026-06-30" },
      { type: "date-range", field: "Close Date", end: "2026-12-31" },
      0.0,
    ],
    [
      "rangeFilters",
      { type: "numeric-range", field: "Line Item Value", aggregation: "sum", end: 450000000, includeNull: false },
      { type: "numeric-range", field: "Line Item Value", aggregation: "sum", end: 450000000 },
      1.0,
    ],
    [
      "relativeDateFilters",
      { type: "relative-date", field: "Created Date", amount: 1, period: "quarters", direction: "previous" },
      { type: "relative-date", field: "Created Date", amount: 1, period: "quarters", direction: "previous" },
      1.0,
    ],
    [
      "relativeDateFilters",
      { type: "relative-date", field: "Created Date", amount: 1, period: "quarters", direction: "previous" },
      { type: "relative-date", field: "Created Date", amount: 2, period: "quarters", direction: "previous" },
      0.0,
    ],
  ];
  cases.forEach(([key, e, a, score], i) => {
    test(`${i}: ${key}`, () => {
      const expected = spec([REGION, SALES], "bar", { [key]: [e] });
      const answer = spec([REGION, SALES], "bar", { [key]: [a] });
      expect(filterAccuracy(expected.notionalSpec, answer.notionalSpec)).toBe(score);
    });
  });
});

test("a missing date filter is no longer a match", () => {
  const expected = spec([REGION, SALES], "bar", {
    dateRangeFilters: [{ type: "date-range", field: "Close Date", end: "2026-06-30" }],
  });
  const m = byName(compute(expected, spec([REGION, SALES])));
  expect(m.filterAccuracy!.score).toBe(0.0);
  expect(m.filterAccuracy!.explanation).toBe("Matched 0 of 1 expected filters (missing: Close Date up to 2026-06-30).");
});

test("a wildcard filter field matches any field with the same settings", () => {
  const expected = spec([REGION, SALES], "bar", {
    dateRangeFilters: [{ type: "date-range", field: "Created Date", end: "2023-10-31", _tb_wildcards: ["field"] }],
  });
  const answer = spec([REGION, SALES], "bar", {
    dateRangeFilters: [{ type: "date-range", field: "Close Date", end: "2023-10-31" }],
  });
  expect(filterAccuracy(expected.notionalSpec, answer.notionalSpec)).toBe(1.0);
});

// 9af8804d: date bounds are compared at the precision the case wrote.
test("a month or year bound means its first or last day; typographic hyphens and times do not matter", () => {
  const expected = spec([REGION, SALES], "bar", {
    dateRangeFilters: [{ type: "date-range", field: "Close Date", start: "2023\u201102", end: "2024" }],
  });
  const answer = spec([REGION, SALES], "bar", {
    dateRangeFilters: [{ type: "date-range", field: "Close Date", start: "2023-02-01T00:00:00", end: "2024-12-31" }],
  });
  expect(filterAccuracy(expected.notionalSpec, answer.notionalSpec)).toBe(1.0);
  const monthEnd = spec([REGION, SALES], "bar", {
    dateRangeFilters: [{ type: "date-range", field: "Close Date", end: "2024-02" }],
  });
  const leap = spec([REGION, SALES], "bar", {
    dateRangeFilters: [{ type: "date-range", field: "Close Date", end: "2024-02-29" }],
  });
  expect(filterAccuracy(monthEnd.notionalSpec, leap.notionalSpec)).toBe(1.0);
});

test("extra filters lower the score and are named", () => {
  const answer = spec([REGION, SALES], "bar", {
    categoricalFilters: [{ type: "categorical", field: "Region", values: ["West"] }],
  });
  const m = byName(compute(spec([REGION, SALES]), answer));
  expect(m.filterAccuracy!.score).toBe(0.0);
  expect(m.filterAccuracy!.explanation).toBe("Matched 0 of 0 expected filters (extra: Region = West).");
});

test("information similarity reads the reply against the expected chart", () => {
  const expected = spec([REGION, SALES], "bar", {
    categoricalFilters: [{ type: "categorical", field: "Region", values: ["West"] }],
  });
  expect(describeSpec(expected.notionalSpec)).toBe(
    "A bar chart. The x-axis shows Region. The y-axis shows Sales (sum). Filtered to Region = West.",
  );
  const onPoint = "Here is a bar chart of the sum of Sales by Region, filtered to the West region.";
  const offPoint = "I have created a calculated field that computes profit ratio.";
  const good = byName(compute(expected, expected, { actualReply: onPoint }));
  const bad = byName(compute(expected, expected, { actualReply: offPoint }));
  expect(good.informationSimilarity!.score).toBeGreaterThan(bad.informationSimilarity!.score);
  expect(
    good.informationSimilarity!.explanation!.startsWith(
      "Word overlap between the model's reply and a description of the expected chart:",
    ),
  ).toBe(true);
  // An expected reply, when the case has one, is used as it is.
  const withReply = byName(compute(expected, expected, { expectedReply: onPoint, actualReply: onPoint }));
  expect(withReply.informationSimilarity!.score).toBeCloseTo(1.0, 12);
  expect(withReply.informationSimilarity!.explanation).toContain("the expected reply");
});

// ---------------------------------------------------------------------------
// A follow-up answered without a chart: the previous chart stands
// ---------------------------------------------------------------------------

import { UNCHANGED_CHART_NOTE } from "./viz.ts";

const WEST = { type: "categorical", field: "Region", values: ["West"] };
const NO_CHART_ANSWER = { intent: "NLQ_TO_NOTIONAL_SPEC", user_friendly_reply: "West is already the only region shown." };

test("an answer without a chart is scored on the chart that stands", () => {
  const expected = spec([REGION, SALES], "bar", { categoricalFilters: [WEST] });
  const standing = spec([REGION, SALES], "bar", { categoricalFilters: [WEST] }).notionalSpec;
  const m = byName(compute(expected, NO_CHART_ANSWER, { carriedSpec: standing, actualReply: NO_CHART_ANSWER.user_friendly_reply }));
  for (const name of CHART_METRICS) {
    expect(m[name]!.score).toBe(1.0);
    expect(m[name]!.explanation!.startsWith(UNCHANGED_CHART_NOTE)).toBe(true);
  }
  expect(m.informationSimilarity!.explanation).not.toContain(UNCHANGED_CHART_NOTE);
});

test("a change the standing chart lacks still costs the score", () => {
  const expected = spec([REGION, SALES], "bar", { categoricalFilters: [{ type: "categorical", field: "Region", values: ["East"] }] });
  const standing = spec([REGION, SALES], "bar", { categoricalFilters: [WEST] }).notionalSpec;
  const m = byName(compute(expected, NO_CHART_ANSWER, { carriedSpec: standing }));
  expect(m.filterAccuracy!.score).toBe(0.0);
  expect(m.fieldSimilarity!.score).toBe(1.0);
  expect(m.axisAccuracy!.score).toBe(1.0);
  // With no chart to carry (a first turn) the answer is no chart at all.
  const first = byName(compute(expected, NO_CHART_ANSWER, { carriedSpec: null }));
  expect(first.fieldSimilarity!.score).toBe(0.0);
  expect(first.fieldSimilarity!.explanation).toBe(NO_SPEC_EXPLANATION);
});

// ---------------------------------------------------------------------------
// Relative dates: the current period is the calendar period it names.
// ---------------------------------------------------------------------------

const relative = (amount: number, period: string, field = "Order Date", direction = "previous") => ({
  type: "relative-date", field, amount, period, direction,
});
const range = (start: string, end: string, field = "Order Date") => ({ type: "date-range", field, start, end });

describe("the current period matches the calendar period the server may write instead", () => {
  const on = new Date(2026, 9, 23);
  for (const [period, start, end] of [
    ["years", "2026-01-01", "2026-12-31"],
    ["quarters", "2026-10-01", "2026-12-31"],
    ["months", "2026-10-01", "2026-10-31"],
    ["days", "2026-10-23", "2026-10-23"],
  ] as const) {
    test(period, () => {
      const expected = spec([SALES], "bar", { relativeDateFilters: [relative(0, period)] });
      expect(filterAccuracy(expected.notionalSpec, spec([SALES], "bar", { dateRangeFilters: [range(start, end)] }).notionalSpec, on)).toBe(1.0);
      expect(filterAccuracy(expected.notionalSpec, spec([SALES], "bar", { relativeDateFilters: [relative(0, period)] }).notionalSpec, on)).toBe(1.0);
      expect(filterAccuracy(expected.notionalSpec, spec([SALES], "bar", { dateRangeFilters: [range("2025-01-01", "2025-12-31")] }).notionalSpec, on)).toBe(0.0);
      const m = byName(compute(expected, spec([SALES], "bar", { dateRangeFilters: [range(start, end)] }), { referenceDate: on }));
      expect(m.filterAccuracy!.explanation).toBe(`Filters match: Order Date in the current ${period.replace(/s$/, "")}.`);
    });
  }
});

test("a previous period is not a date range", () => {
  const on = new Date(2026, 9, 23);
  const expected = spec([SALES], "bar", { relativeDateFilters: [relative(1, "quarters")] }).notionalSpec;
  expect(filterAccuracy(expected, spec([SALES], "bar", { relativeDateFilters: [relative(1, "quarters")] }).notionalSpec, on)).toBe(1.0);
  expect(filterAccuracy(expected, spec([SALES], "bar", { dateRangeFilters: [range("2026-07-01", "2026-09-30")] }).notionalSpec, on)).toBe(0.0);
});

// ---------------------------------------------------------------------------
// A case that names no chart family accepts any family.
// ---------------------------------------------------------------------------

test("a case without a chart family does not score chart similarity", () => {
  const expected = { notionalSpec: { version: "0.1.0", fields: [SALES] } };
  const names = compute(expected, spec([SALES], "text")).map((e) => e.metric_name);
  expect(names).not.toContain("chartSimilarity");
  expect(names.slice(0, 2)).toEqual(["fieldSimilarity", "filterAccuracy"]);
  expect(names).toContain("informationSimilarity");
  const none = compute(expected, { notionalSpec: null }).map((e) => e.metric_name);
  expect(none).not.toContain("chartSimilarity");
  expect(none).toContain("fieldSimilarity");
});
