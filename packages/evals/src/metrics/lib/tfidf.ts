/**
 * TF-IDF + cosine similarity, faithful to scikit-learn's DEFAULT TfidfVectorizer
 * as checked against scikit-learn fixtures:
 *
 *     vectorizer = TfidfVectorizer().fit_transform(sentences)
 *     similarity_matrix = cosine_similarity(vectorizer, vectorizer)
 *
 * Faithfulness points reproduced:
 *  - default token_pattern = /(?u)\b\w\w+\b/  -> tokens need 2+ "word" chars.
 *    Single-char tokens are dropped. Because \w and \b here are matched with a
 *    Unicode-aware engine, CJK codepoints ARE word characters, so a run of 2+
 *    CJK chars forms one token. (See divergence note below.)
 *  - lowercasing on
 *  - smoothed idf: idf(t) = ln((1 + n) / (1 + df(t))) + 1   (smooth_idf=True)
 *  - sublinear_tf = False (raw term counts)
 *  - l2 normalization of each tf-idf row
 *  - cosine_similarity of the (already l2-normalized) matrix = dot products,
 *    clamped: identical rows -> exactly 1.0, orthogonal -> 0.0.
 *
 * DIVERGENCE NOTE (documented, matches golden README "unicode_text" flag):
 * sklearn's default token_pattern is applied by Python's `re` with the (?u) flag,
 * where \w matches Unicode word chars (letters, digits, underscore, and many
 * CJK/ideographic codepoints). JS RegExp with the /u/v flag and \w only matches
 * [A-Za-z0-9_]. To faithfully reproduce sklearn we therefore use a Unicode
 * property-class token pattern (\p{L}\p{N}_ as the "word char" class) so that
 * accented Latin ("café") and CJK ("売上高...") tokenize the same way sklearn's
 * `re` module does. This makes the golden's unicode_text case match exactly.
 */

// sklearn token = 2+ consecutive "word" characters.
// Python re `\w` under (?u): letters, digits, underscore (Unicode-aware).
// We emulate that class with Unicode property escapes.
const TOKEN_RE = /[\p{L}\p{N}_][\p{L}\p{N}_]+/gu;

/** Tokenize a single document the way sklearn's default analyzer does. */
export function tokenize(doc: string): string[] {
  const lowered = doc.toLowerCase();
  const matches = lowered.match(TOKEN_RE);
  return matches ? matches : [];
}

/**
 * Compute the TF-IDF matrix (rows = documents, cols = sorted vocabulary) using
 * sklearn's default TfidfVectorizer parameters, then return it l2-normalized.
 */
export function tfidfMatrix(docs: string[]): { matrix: number[][]; vocabulary: string[] } {
  const n = docs.length;
  const tokenized = docs.map(tokenize);

  // Build vocabulary: sorted set of tokens (sklearn sorts the vocabulary).
  const vocabSet = new Set<string>();
  for (const toks of tokenized) for (const t of toks) vocabSet.add(t);
  const vocabulary = Array.from(vocabSet).sort();
  const vocabIndex = new Map<string, number>();
  vocabulary.forEach((t, i) => vocabIndex.set(t, i));
  const V = vocabulary.length;

  // Term counts (raw tf, sublinear_tf=False).
  const counts: number[][] = tokenized.map((toks) => {
    const row = new Array<number>(V).fill(0);
    for (const t of toks) {
      const idx = vocabIndex.get(t);
      if (idx !== undefined) row[idx] += 1;
    }
    return row;
  });

  // Document frequency per term.
  const df = new Array<number>(V).fill(0);
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < n; i++) {
      if (counts[i][j] > 0) df[j] += 1;
    }
  }

  // Smoothed idf: ln((1 + n) / (1 + df)) + 1
  const idf = new Array<number>(V);
  for (let j = 0; j < V; j++) {
    idf[j] = Math.log((1 + n) / (1 + df[j])) + 1;
  }

  // tf-idf then l2-normalize each row.
  const matrix: number[][] = counts.map((row) => {
    const tfidf = row.map((c, j) => c * idf[j]);
    let norm = 0;
    for (const v of tfidf) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return tfidf; // all-zero row stays zero
    return tfidf.map((v) => v / norm);
  });

  return { matrix, vocabulary };
}

/**
 * Cosine similarity matrix of the docs' tf-idf vectors with themselves.
 * Since rows are l2-normalized, cosine = dot product. Matches
 * sklearn.metrics.pairwise.cosine_similarity(m, m).
 */
export function cosineSimilarityMatrix(docs: string[]): number[][] {
  const { matrix } = tfidfMatrix(docs);
  const n = matrix.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      let dot = 0;
      const a = matrix[i];
      const b = matrix[j];
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
      row.push(dot);
    }
    out.push(row);
  }
  return out;
}

/**
 * Off-diagonal cosine-similarity accumulation without materializing the full
 * n×n matrix — the value ConcisenessScorer actually needs (mean of the
 * off-diagonal, i.e. `np.fill_diagonal(sim,0); np.mean(sim)`).
 *
 * Returns `{ sum, n }` where `sum` is Σ_{i≠j} cos(i,j) accumulated in the SAME
 * order (i outer, j inner, skip i==j) as the previous matrix-then-sum code, so
 * the floating-point result is byte-identical to building the matrix first.
 * The caller computes the mean as `sum / (n*n)`.
 */
export function offDiagonalSimilaritySum(docs: string[]): { sum: number; n: number } {
  const { matrix } = tfidfMatrix(docs);
  const n = matrix.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = matrix[i];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = matrix[j];
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
      sum += dot;
    }
  }
  return { sum, n };
}
