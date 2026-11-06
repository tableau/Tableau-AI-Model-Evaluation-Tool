/**
 * Title Case for buttons, dialog titles and tab headers (the text guidelines):
 * every word capitalized except articles, conjunctions and prepositions of
 * four letters or fewer after the first word. A word that is already
 * capitalized (AI, Tableau) is left as it is.
 */
const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'as', 'at', 'by', 'for', 'from',
  'in', 'into', 'of', 'on', 'onto', 'per', 'to', 'up', 'with', 'over',
]);

export const titleCase = (s: string): string =>
  s
    .split(' ')
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ');
