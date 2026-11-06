/**
 * rapidfuzz-compatible fuzzy ratios: `token_set_ratio` and `partial_ratio`,
 * checked against RapidFuzz fixtures:
 *
 *     fuzz.token_set_ratio(a.strip().lower(), b.lower())
 *     fuzz.partial_ratio(a.strip().lower(), b.lower())
 *
 * These are LIB-SPECIFIC definitions. We port rapidfuzz's own algorithms
 * (fuzz_py.py in rapidfuzz 3.14.6) directly, rather than substituting a
 * different fuzzy library, so values match to float-epsilon.
 *
 * Core primitives (rapidfuzz):
 *   indel_distance(a, b) = len(a) + len(b) - 2 * LCS(a, b)
 *   ratio(a, b)          = 100 * (1 - indel_distance / (len(a) + len(b)))
 *                        = 100 * 2*LCS / (len(a)+len(b))
 *
 * RapidFuzz does NOT collapse internal
 * whitespace in `partial_ratio` (e.g. "  total   revenue  " (stripped) vs
 * "total revenue" -> 84.6, not 100). We operate on the raw (only lowercased/
 * caller-stripped) strings and never normalize internal whitespace.
 */

function popcount(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Bit-parallel LCS: each bit represents an increment in a DP row.
 * Updating 32 cells at once retains exact Indel scores, without an m×n table.
 * Compile the fixed string once and reuse its masks across partial-ratio windows.
 * Indices deliberately remain UTF-16 code units, matching the previous scorer. */
function lcsCounter(fixed: string): (text: string, start?: number, end?: number) => number {
  const words = Math.ceil(fixed.length / 32);
  const masks = new Map<string, Uint32Array>();
  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];
    let mask = masks.get(char);
    if (!mask) {
      mask = new Uint32Array(words);
      masks.set(char, mask);
    }
    mask[i >>> 5] |= 1 << (i & 31);
  }
  const state = new Uint32Array(words);
  return (text, start = 0, end = text.length) => {
    state.fill(0);
    for (let i = start; i < end; i++) {
      const mask = masks.get(text[i]);
      if (!mask) continue;
      let shiftCarry = 1;
      let borrow = 0;
      for (let word = 0; word < words; word++) {
        const previous = state[word];
        const x = (mask[word] | previous) >>> 0;
        const y = ((previous << 1) | shiftCarry) >>> 0;
        shiftCarry = previous >>> 31;
        // JS numbers safely represent this 33-bit intermediate. Explicitly
        // carry the subtraction borrow between unsigned 32-bit words.
        const difference = x - y - borrow;
        borrow = difference < 0 ? 1 : 0;
        state[word] = x & ~difference;
      }
    }
    let count = 0;
    for (const word of state) count += popcount(word);
    return count;
  };
}

/** Longest common subsequence length, with masks for the shorter string. */
function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  return a.length <= b.length ? lcsCounter(a)(b) : lcsCounter(b)(a);
}

/** rapidfuzz Indel distance = len1 + len2 - 2*LCS. */
function indelDistance(a: string, b: string): number {
  return a.length + b.length - 2 * lcsLength(a, b);
}

/** rapidfuzz _norm_distance: 100 * (1 - dist/lensum) (Indel normalized). */
function normDistance(dist: number, lensum: number): number {
  if (lensum === 0) return 100.0;
  return 100.0 * (1 - dist / lensum);
}

/** rapidfuzz `ratio` (Indel-normalized similarity) in [0, 100]. */
export function ratio(a: string, b: string): number {
  const lensum = a.length + b.length;
  if (lensum === 0) return 100.0;
  return normDistance(indelDistance(a, b), lensum);
}

/**
 * rapidfuzz `_partial_ratio_impl` — assumes len(shorter) <= len(longer).
 * Checks three families of windows in `longer`:
 *   1. prefixes  longer[:i]        for i in 1 .. len1-1
 *   2. full-len  longer[i:i+len1]  for i in 0 .. len2-len1-1
 *   3. suffixes  longer[i:]        for i in len2-len1 .. len2-1
 * returning the max `ratio(shorter, window)`. Direct port of fuzz_py.py.
 */
function partialRatioImpl(shorter: string, longer: string): number {
  const len1 = shorter.length;
  const len2 = longer.length;
  const s1CharSet = new Set(shorter);
  const countLcs = lcsCounter(shorter);
  let best = 0;

  const consider = (start: number, end: number) => {
    const r = normDistance(
      len1 + end - start - 2 * countLcs(longer, start, end),
      len1 + end - start,
    );
    if (r > best) best = r;
  };

  for (let i = 1; i < len1; i++) {
    if (!s1CharSet.has(longer[i - 1])) continue;
    consider(0, i);
    if (best === 100.0) return 100.0;
  }
  for (let i = 0; i < len2 - len1; i++) {
    if (!s1CharSet.has(longer[i + len1 - 1])) continue;
    consider(i, i + len1);
    if (best === 100.0) return 100.0;
  }
  for (let i = len2 - len1; i < len2; i++) {
    if (!s1CharSet.has(longer[i])) continue;
    consider(i, len2);
    if (best === 100.0) return 100.0;
  }
  return best;
}

/**
 * rapidfuzz `partial_ratio`. Orders (shorter, longer) by length, runs the impl,
 * and — when len1 == len2 and not already 100 — also runs the impl with the
 * roles swapped and takes the better score (matches fuzz_py.py L328-332). This
 * is what makes e.g. "revenue total" vs "total revenue" -> 70.0.
 */
export function partialRatio(s1: string, s2: string): number {
  if (s1.length === 0 && s2.length === 0) return 100.0;
  const len1 = s1.length;
  const len2 = s2.length;
  const shorter = len1 <= len2 ? s1 : s2;
  const longer = len1 <= len2 ? s2 : s1;

  let score = partialRatioImpl(shorter, longer);
  if (score !== 100.0 && len1 === len2) {
    const score2 = partialRatioImpl(longer, shorter);
    if (score2 > score) score = score2;
  }
  return score;
}

/** Split on whitespace, drop empties (rapidfuzz default token split). */
function splitTokens(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * rapidfuzz `token_set_ratio`. Direct port of fuzz_py.py L395-506:
 *   - tokens_a/b = sets of whitespace-split tokens
 *   - if either empty -> 0
 *   - intersect / diff_ab / diff_ba
 *   - if intersect and (no diff_ab or no diff_ba) -> 100
 *   - compute the three candidate ratios using Indel distances over the
 *     sorted-joined diff strings and the intersection length, take the max.
 */
export function tokenSetRatio(s1: string, s2: string): number {
  const tokensA = new Set(splitTokens(s1));
  const tokensB = new Set(splitTokens(s2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersect = [...tokensA].filter((t) => tokensB.has(t));
  const diffAb = [...tokensA].filter((t) => !tokensB.has(t));
  const diffBa = [...tokensB].filter((t) => !tokensA.has(t));

  // one sentence is part of the other
  if (intersect.length > 0 && (diffAb.length === 0 || diffBa.length === 0)) {
    return 100;
  }

  const join = (toks: string[]) => toks.join(" ");
  const diffAbJoined = join(diffAb.slice().sort());
  const diffBaJoined = join(diffBa.slice().sort());

  const abLen = diffAbJoined.length;
  const baLen = diffBaJoined.length;
  const sectLen = join(intersect).length;

  // rapidfuzz: sect_ab_len = sect_len + (sect_len != 0) + ab_len (the +1 is the
  // separating space between the intersection and the diff, present iff sect).
  const sep = sectLen !== 0 ? 1 : 0;
  const sectAbLen = sectLen + sep + abLen;
  const sectBaLen = sectLen + sep + baLen;

  // result: ratio(sect+ab, sect+ba) computed via indel_distance(diff_ab, diff_ba)
  // over the combined lengths (the common `sect` part contributes 0 distance).
  const dist = indelDistance(diffAbJoined, diffBaJoined);
  const result = normDistance(dist, sectAbLen + sectBaLen);

  if (sectLen === 0) return result;

  // sect_ab_dist = (sect_len != 0) + ab_len ; ratio vs sect-only string
  const sectAbDist = sep + abLen;
  const sectAbRatio = normDistance(sectAbDist, sectLen + sectAbLen);

  const sectBaDist = sep + baLen;
  const sectBaRatio = normDistance(sectBaDist, sectLen + sectBaLen);

  return Math.max(result, sectAbRatio, sectBaRatio);
}
