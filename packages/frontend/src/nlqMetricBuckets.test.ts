/**
 * Parity check for the scoring rules: this file and the core metric catalog
 * compute the same fixture (`goldens/metric_catalog/metric_parity.json`) against the
 * expected values it carries, so the score on the results page and the
 * score in an export or the published datasource cannot drift apart.
 */

import {
  BucketValue,
  StageMetrics,
  bucketOverall,
  computeAggregateBuckets,
  computeRowBuckets,
  rowVerdict,
  weightedOverall,
  QUALITY_CARDS,
  readableExplanation,
} from "./nlqMetricBuckets";

// eslint-disable-next-line @typescript-eslint/no-var-requires
// The shared fixture lives at goldens/metric_catalog/; run by `bun test`.
const fixture = require("../../../goldens/metric_catalog/metric_parity.json") as {
  rows: Record<string, StageMetrics>;
  expected: {
    per_row: Record<string, Expected>;
    aggregates: Record<string, Expected & { rows: string[] }>;
  };
};

interface Expected {
  buckets: Record<string, number | null>;
  unweighted: number | null;
  overall: number | null;
  verdict?: string;
  cards: Record<string, number | null>;
}

const avgs = (buckets: BucketValue[]): Record<string, number | null> =>
  Object.fromEntries(buckets.map((b) => [b.def.key, b.avg]));

/** The page's quality-card headline: unweighted mean of the card's populated categories. */
const cardScores = (buckets: BucketValue[]): Record<string, number | null> => {
  const byKey = new Map(buckets.map((b) => [b.def.key, b]));
  const out: Record<string, number | null> = {};
  for (const card of QUALITY_CARDS) {
    const populated = card.buckets
      .map((k) => byKey.get(k))
      .filter((b): b is BucketValue => !!b);
    out[card.key] = populated.length ? bucketOverall(populated) : null;
  }
  return out;
};

const expectClose = (got: number | null | undefined, want: number | null) => {
  if (want === null) expect(got).toBeNull();
  else expect(got).toBeCloseTo(want, 9);
};

const expectSame = (got: Record<string, number | null>, want: Record<string, number | null>) => {
  expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  for (const k of Object.keys(want)) expectClose(got[k], want[k]);
};

describe("scoring parity with the backend", () => {
  for (const [key, sm] of Object.entries(fixture.rows)) {
    test(`row ${key}`, () => {
      const exp = fixture.expected.per_row[key];
      const buckets = computeRowBuckets(sm);
      expectSame(avgs(buckets), exp.buckets);
      expectClose(bucketOverall(buckets), exp.unweighted);
      expectClose(weightedOverall(buckets), exp.overall);
      expect(rowVerdict(buckets)).toBe(exp.verdict);
      expectSame(cardScores(buckets), exp.cards);
    });
  }

  for (const [name, exp] of Object.entries(fixture.expected.aggregates)) {
    test(`aggregate ${name}`, () => {
      const buckets = computeAggregateBuckets(exp.rows.map((k) => fixture.rows[k]));
      expectSame(avgs(buckets), exp.buckets);
      expectClose(bucketOverall(buckets), exp.unweighted);
      expectClose(weightedOverall(buckets), exp.overall);
      expectSame(cardScores(buckets), exp.cards);
    });
  }
});

describe("readableExplanation", () => {
  const tokens = "expecting {EOL, WSS, LINECOMMENT, '(', FIELDNAME, IF, CASE}";
  it("says the model wrote no formula instead of the parser's end-of-input error", () => {
    const plain = "The model did not write a formula for this request, so there was nothing to check.";
    expect(readableExplanation(`Syntax Error: Syntax error at line 1, column 0: mismatched input '<EOF>' ${tokens}`)).toBe(plain);
    expect(readableExplanation("Empty formula")).toBe(plain);
  });
  it("keeps where a real syntax error is and drops the token list", () => {
    expect(readableExplanation(`Syntax Error: Syntax error at line 1, column 23: mismatched input ')' ${tokens}`))
      .toBe("Syntax Error: Syntax error at line 1, column 23: mismatched input ')'");
  });
  it("joins a list of findings instead of failing on it", () => {
    expect(readableExplanation(["Empty formula", "Unrecognized function: rank_dense"]))
      .toBe("The model did not write a formula for this request, so there was nothing to check.; Unrecognized function: rank_dense");
    expect(readableExplanation([])).toBeNull();
  });
  it("leaves every other explanation alone", () => {
    expect(readableExplanation("Type mismatch in CASE ELSE: expected number, found None")).toBe("Type mismatch in CASE ELSE: expected number, found None");
    expect(readableExplanation(null)).toBeNull();
  });
});
