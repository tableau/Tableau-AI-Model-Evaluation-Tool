/** Synthetic preview data, not values from the Tableau datasource. */
export interface PreviewField {
  caption?: string;
  fieldIdentifier?: string;
  name?: string;
  data?: string;
  role?: string;
  aggregation?: string;
}

const SAMPLE_CATEGORIES = [
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta",
];

export const TEMPORAL_AGGS = new Set(["year", "qtr", "month", "week", "day", "hour"]);

/** Seed by field identity, never its position or encoding in the chart definition. */
function fieldSeed(caption: string): number {
  const key = caption.trim().replace(/\s+/g, " ").toLowerCase();
  let hash = 2166136261;
  for (const char of key) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

/**
 * Measures seeded by array index are unstable: simply reversing
 * fields makes matching expected/actual charts look different.
 */
export function generateSyntheticRows(
  fields: readonly PreviewField[],
  count = 8,
  /** The values a categorical filter keeps, by field: the rows show them. */
  categories: Record<string, string[]> = {},
): Record<string, string | number>[] {
  const seeds = fields.map((f) => fieldSeed(f.caption || f.fieldIdentifier || f.name || "Field"));
  return Array.from({ length: count }, (_, i) => {
    const row: Record<string, string | number> = {};
    fields.forEach((f, j) => {
      const caption = f.caption || f.fieldIdentifier || f.name || "Field";
      const kept = categories[caption];
      if (f.data === "date" || TEMPORAL_AGGS.has(f.aggregation || "")) {
        row[caption] = `202${i % 5}-${String((i % 12) + 1).padStart(2, "0")}-15`;
      } else if (f.data === "number" || f.role === "measure") {
        row[caption] = Math.round(Math.abs(Math.sin(i * 31 + seeds[j] * 17 + 7)) * 100 + 10);
      } else if (kept && kept.length) {
        row[caption] = kept[i % kept.length]!;
      } else {
        row[caption] = SAMPLE_CATEGORIES[i % SAMPLE_CATEGORIES.length]!;
      }
    });
    return row;
  });
}
