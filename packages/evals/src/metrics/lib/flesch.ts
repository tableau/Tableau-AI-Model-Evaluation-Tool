/**
 * Flesch Reading Ease, checked against public readability-library fixtures:
 *
 *     round(Readability(text).flesch().score / 100, 4)
 *
 * py-readability-metrics computes:
 *   - num_words / num_syllables / num_letters via nltk TweetTokenizer +
 *     readability's _is_punctuation filter + its syllable heuristic
 *   - num_sentences via nltk sent_tokenize (punkt) — BLOCKED in the golden env,
 *     so the golden supplies a manual sentence count instead.
 *   - score = 206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)
 *   - if num_words < 100 the library raises; the reference then returns 1.0000.
 *
 * This module provides:
 *   (a) fleschScore(counts)         — the exact formula (matches golden exactly)
 *   (b) fleschScoreDiv100(counts)   — round(score/100, 4), what the code stores
 *   (c) countWords/Syllables/Letters — a JS substitute for TweetTokenizer +
 *       readability's syllable counter (ported verbatim)
 *   (d) countSentences              — a JS sentence tokenizer (the punkt
 *       substitute) — see DIVERGENCE NOTE.
 *   (e) readingEase(text)           — full pipeline with the <100-words -> 1.0
 *       fallback, mirroring the reference.
 *
 * DIVERGENCE NOTE (accepted substitution, per plan):
 * The Python path uses nltk's punkt for sentence segmentation. punkt was
 * download-blocked when the golden was made, so the golden records a MANUAL
 * sentence count. Our `countSentences` is a lightweight regex tokenizer
 * (split on ., !, ? terminators). It reproduces the manual counts for the two
 * golden paragraphs, but a heuristic tokenizer WILL diverge from punkt on
 * abbreviations, decimals ("4.2"), ellipses, quoted terminators, etc. This is a
 * known, accepted substitution point (flagged in the report), not a bug.
 */

export type FleschCounts = {
  numWords: number;
  numSentences: number;
  numSyllables: number;
};

/** Flesch Reading Ease raw formula. */
export function fleschScore(counts: FleschCounts): number {
  const { numWords, numSyllables } = counts;
  // Clamp sentence count to >=1 to avoid division-by-zero → non-finite score
  // (mirrors py-readability, which always has at least one sentence).
  const numSentences = Math.max(1, counts.numSentences);
  const wordsPerSentence = numWords / numSentences;
  const syllablesPerWord = numSyllables / numWords;
  return 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
}

/** round(x, decimals) matching Python's round() (banker's rounding). */
function pyRound(x: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  const EPS = 1e-9;
  if (Math.abs(diff - 0.5) < EPS) {
    // round half to even
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / f;
}

/** What ReadabilityScorer stores: round(score/100, 4). */
export function fleschScoreDiv100(counts: FleschCounts): number {
  return pyRound(fleschScore(counts) / 100, 4);
}

// readability's _is_punctuation: single-char token in this set.
const PUNCT_RE = /^[.,\/#!$%'\^&\*;:{}=\-_`~()]$/;
function isPunctuation(token: string): boolean {
  return PUNCT_RE.test(token);
}

/**
 * Tokenize prose the way nltk TweetTokenizer does for these inputs: split on
 * whitespace, then peel leading/trailing punctuation into separate single-char
 * tokens. (Sufficient for plain narrative text; TweetTokenizer has extra
 * handling for emoticons/URLs/handles that these inputs don't exercise.)
 */
export function tweetTokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    let s = raw;
    // peel leading punctuation chars
    const lead: string[] = [];
    while (s.length > 0 && isPunctuation(s[0])) {
      lead.push(s[0]);
      s = s.slice(1);
    }
    // peel trailing punctuation chars
    const trail: string[] = [];
    while (s.length > 0 && isPunctuation(s[s.length - 1])) {
      trail.unshift(s[s.length - 1]);
      s = s.slice(0, -1);
    }
    for (const c of lead) tokens.push(c);
    if (s.length > 0) tokens.push(s);
    for (const c of trail) tokens.push(c);
  }
  return tokens;
}

/** readability.text.syllables.count, ported verbatim. */
export function countWordSyllables(word: string): number {
  let w = String(word).toLowerCase();
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]e)$/, "");
  w = w.replace(/^y/, "");
  const matches = w.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 0;
}

/** num_words / num_syllables / num_letters over non-punctuation tokens. */
export function wordStats(text: string): {
  numWords: number;
  numSyllables: number;
  numLetters: number;
} {
  const tokens = tweetTokenize(text);
  let numWords = 0;
  let numSyllables = 0;
  let numLetters = 0;
  for (const t of tokens) {
    if (!isPunctuation(t)) {
      numWords += 1;
      numSyllables += countWordSyllables(t);
      numLetters += t.length;
    }
  }
  return { numWords, numSyllables, numLetters };
}

/**
 * JS sentence tokenizer (punkt substitute). Counts runs terminated by one or
 * more of . ! ? (collapsing consecutive terminators), ignoring a trailing
 * terminator with no following text as still closing the last sentence.
 * See DIVERGENCE NOTE at top of file.
 */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Split on sentence terminators followed by whitespace or end of string.
  const parts = trimmed
    .split(/[.!?]+(?:\s+|$)/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length;
}

/**
 * Full Flesch reading-ease pipeline mirroring ReadabilityScorer, including the
 * <100-words -> 1.0000 fallback (the library raises for short texts).
 * Returns round(score/100, 4).
 */
export function readingEase(text: string): number {
  const { numWords, numSyllables } = wordStats(text);
  if (numWords < 100) return 1.0;
  const numSentences = Math.max(1, countSentences(text));
  return fleschScoreDiv100({ numWords, numSentences, numSyllables });
}
