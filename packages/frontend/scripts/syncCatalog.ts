// Refresh src/metricCatalog.json from @tableau-ai-eval/core's metrics/catalog.json, the
// one description of every metric the tool scores. Runs before `vite` dev/build
// (package.json predev/prebuild) so the page and the backend can never
// disagree about a category, a weight or a label. A core test
// (packages/core/src/metrics/catalog.test.ts) compares the two files as well.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "core", "src", "metrics", "catalog.json");
const target = resolve(here, "..", "src", "metricCatalog.json");

if (!existsSync(source)) {
  console.warn(`syncCatalog: ${source} not found; keeping src/metricCatalog.json as is`);
  process.exit(0);
}
const data = readFileSync(source);
if (!existsSync(target) || !data.equals(readFileSync(target))) {
  writeFileSync(target, data);
  console.log("syncCatalog: src/metricCatalog.json refreshed from core metrics/catalog.json");
}
