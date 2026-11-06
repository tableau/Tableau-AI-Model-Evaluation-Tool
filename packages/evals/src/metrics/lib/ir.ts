/**
 * IR metrics faithful to `ranx` for ranking and
 * FieldRankScorer:
 *
 *     qrels = ranx.Qrels({query: {doc: rel,...}})
 *     run   = ranx.Run({query: {doc: score,...}})
 *     ranx.evaluate(qrels, run, ["hit_rate@1","hit_rate@5","hit_rate@10",
 *                                "map","mrr","precision","recall"],
 *                   make_comparable=True)
 *
 * All cases here use a single query. A doc is "relevant" if its qrels grade >= 1.
 *
 * --- TIE BEHAVIOR (pre-flagged divergence, faithfully reproduced) ---
 * ranx ranks by score descending. For docs with EQUAL scores, ranx's ordering
 * effectively places the RELEVANT doc AFTER equally-scored non-relevant docs
 * (verified against the golden):
 *   - tie_equal_scores: {dX:0.5, dR:0.5, dY:0.2}, dR relevant
 *       -> dR at rank 2 (mrr=0.5), hit_rate@1=0.
 *   - tie_all_equal: {dA:0.5, dB:0.5, dR:0.5}, dR relevant
 *       -> dR at rank 3 (mrr=map=1/3).
 * We replicate this by, within a tie group, ordering NON-relevant docs before
 * relevant docs. This matches ranx's observed tie resolution for these goldens.
 *
 * --- EMPTY RUN (pre-flagged) ---
 * ranx cannot build a Run from an empty ranking. The reference code
 * short-circuits BEFORE ranx.evaluate (returns 0.0 per metric when actual is
 * empty). We mirror that: `evaluate` throws EmptyRunError for an empty ranking;
 * callers should short-circuit. The golden records `_ranx_evaluated: false`.
 *
 * --- precision ---
 * ranx `precision` here is relevant-retrieved / total-retrieved (NOT normalized
 * by k). E.g. 2 relevant among 4 retrieved -> 0.5.
 */

export type QrelsForQuery = Record<string, number>;
export type RunForQuery = Record<string, number>;

export class EmptyRunError extends Error {
  constructor() {
    super("ranx cannot build a Run from an empty ranking (caller must short-circuit)");
    this.name = "EmptyRunError";
  }
}

/**
 * Rank the run docs the way ranx does: score descending, and within a tie group
 * order non-relevant docs before relevant docs (see tie note above).
 * Returns the ordered list of {doc, relevant} entries.
 */
function rankRun(
  run: RunForQuery,
  qrels: QrelsForQuery,
): { doc: string; relevant: boolean }[] {
  const isRel = (doc: string) => (qrels[doc] ?? 0) >= 1;
  const entries = Object.keys(run).map((doc) => ({
    doc,
    score: run[doc],
    relevant: isRel(doc),
  }));
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score; // score desc
    // tie: non-relevant (false=0) before relevant (true=1)
    return Number(a.relevant) - Number(b.relevant);
  });
  return entries.map((e) => ({ doc: e.doc, relevant: e.relevant }));
}

function relevantDocs(qrels: QrelsForQuery): string[] {
  return Object.keys(qrels).filter((d) => (qrels[d] ?? 0) >= 1);
}

/** hit_rate@k: 1.0 if any relevant doc appears in the top-k, else 0.0. */
export function hitRateAtK(qrels: QrelsForQuery, run: RunForQuery, k: number): number {
  if (Object.keys(run).length === 0) throw new EmptyRunError();
  const ranked = rankRun(run, qrels);
  const topK = ranked.slice(0, k);
  return topK.some((e) => e.relevant) ? 1.0 : 0.0;
}

/** mrr: reciprocal rank of the first relevant doc (0 if none retrieved). */
export function mrr(qrels: QrelsForQuery, run: RunForQuery): number {
  if (Object.keys(run).length === 0) throw new EmptyRunError();
  const ranked = rankRun(run, qrels);
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i].relevant) return 1 / (i + 1);
  }
  return 0.0;
}

/** map: average precision over the ranked list (single query). */
export function meanAveragePrecision(qrels: QrelsForQuery, run: RunForQuery): number {
  if (Object.keys(run).length === 0) throw new EmptyRunError();
  const ranked = rankRun(run, qrels);
  const totalRelevant = relevantDocs(qrels).length;
  if (totalRelevant === 0) return 0.0;
  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i].relevant) {
      hits += 1;
      sumPrecision += hits / (i + 1);
    }
  }
  // ranx normalizes by the number of relevant docs (min with retrieved handled
  // implicitly since only retrieved-relevant contribute).
  return sumPrecision / totalRelevant;
}

/** precision: relevant retrieved / total retrieved (ranx unnormalized-by-k). */
export function precision(qrels: QrelsForQuery, run: RunForQuery): number {
  if (Object.keys(run).length === 0) throw new EmptyRunError();
  const ranked = rankRun(run, qrels);
  if (ranked.length === 0) return 0.0;
  const relRetrieved = ranked.filter((e) => e.relevant).length;
  return relRetrieved / ranked.length;
}

/** recall: relevant retrieved / total relevant. */
export function recall(qrels: QrelsForQuery, run: RunForQuery): number {
  if (Object.keys(run).length === 0) throw new EmptyRunError();
  const ranked = rankRun(run, qrels);
  const totalRelevant = relevantDocs(qrels).length;
  if (totalRelevant === 0) return 0.0;
  const relRetrieved = ranked.filter((e) => e.relevant).length;
  return relRetrieved / totalRelevant;
}

/**
 * Evaluate the full metric list for a single query, mirroring
 * ranx.evaluate(qrels, run, metrics). Throws EmptyRunError for an empty ranking
 * so callers can short-circuit exactly as the reference code does.
 */
export function evaluate(
  qrels: QrelsForQuery,
  run: RunForQuery,
  metrics: string[],
): Record<string, number> {
  if (Object.keys(run).length === 0) throw new EmptyRunError();
  const out: Record<string, number> = {};
  for (const m of metrics) {
    if (m.startsWith("hit_rate@")) {
      const k = parseInt(m.slice("hit_rate@".length), 10);
      out[m] = hitRateAtK(qrels, run, k);
    } else if (m === "map") {
      out[m] = meanAveragePrecision(qrels, run);
    } else if (m === "mrr") {
      out[m] = mrr(qrels, run);
    } else if (m === "precision") {
      out[m] = precision(qrels, run);
    } else if (m === "recall") {
      out[m] = recall(qrels, run);
    } else {
      throw new Error(`Unsupported metric: ${m}`);
    }
  }
  return out;
}

export type MultiQrels = Record<string, QrelsForQuery>;
export type MultiRun = Record<string, RunForQuery>;

/**
 * Multi-query evaluate, mirroring `ranx.evaluate(Qrels, Run, metrics,
 * make_comparable=True)` as used by FieldRankScorer.
 *
 * ranx behavior faithfully reproduced (verified against the golden):
 *   - The QUERY SET is the set of qrels keys (make_comparable=True restricts
 *     the run to qrels' queries). Run-only queries are ignored.
 *   - A query whose run ranking is EMPTY (e.g. a chunk whose matches were all
 *     filtered out) still counts as a query, scoring 0 for every metric (no
 *     relevant doc retrieved). ranx.Run silently drops the empty entry but
 *     make_comparable re-introduces it as a 0-scoring query.
 *   - Each metric is the arithmetic MEAN of the per-query scores.
 *
 * NOTE (pre-flagged): ranx raises if a qrels query has an EMPTY grade dict
 * (no relevant docs). FieldRankScorer only builds such a query when the
 * expected calc has no fields; the golden fixtures avoid that (it is an error
 * path in Python too). We throw EmptyRunError in that case so the caller can
 * surface it rather than silently return a value.
 */
export function evaluateMulti(
  qrels: MultiQrels,
  run: MultiRun,
  metrics: string[],
): Record<string, number> {
  const queries = Object.keys(qrels);
  if (queries.length === 0) throw new EmptyRunError();
  const sums: Record<string, number> = {};
  for (const m of metrics) sums[m] = 0;

  for (const q of queries) {
    const qr = qrels[q];
    if (!qr || Object.keys(qr).length === 0) {
      // ranx raises "max() arg is an empty sequence" for an empty-qrels query.
      throw new EmptyRunError();
    }
    const rn = run[q] ?? {};
    for (const m of metrics) {
      if (Object.keys(rn).length === 0) {
        // Empty run for this query -> 0 (no relevant retrieved) under
        // make_comparable=True. Do not call the single-query primitives
        // (they throw EmptyRunError on an empty run).
        sums[m] += 0;
        continue;
      }
      if (m.startsWith("hit_rate@")) {
        const k = parseInt(m.slice("hit_rate@".length), 10);
        sums[m] += hitRateAtK(qr, rn, k);
      } else if (m === "map") {
        sums[m] += meanAveragePrecision(qr, rn);
      } else if (m === "mrr") {
        sums[m] += mrr(qr, rn);
      } else if (m === "precision") {
        sums[m] += precision(qr, rn);
      } else if (m === "recall") {
        sums[m] += recall(qr, rn);
      } else {
        throw new Error(`Unsupported metric: ${m}`);
      }
    }
  }

  const out: Record<string, number> = {};
  for (const m of metrics) out[m] = sums[m] / queries.length;
  return out;
}
