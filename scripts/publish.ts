import { releaseMain } from "./release.ts";

try { await releaseMain(process.argv.slice(2), true); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
