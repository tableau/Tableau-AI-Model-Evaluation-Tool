import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("compiled narrative workers run outside the source checkout", async () => {
  const root = join(import.meta.dir, "..");
  const directory = mkdtempSync(join(tmpdir(), "tableau-ai-eval-worker-smoke-"));
  try {
    const executable = join(directory, process.platform === "win32" ? "smoke.exe" : "smoke");
    // Production also embeds content from outside the checkout, changing Bun's
    // common entrypoint root. Use absolute inputs just like compileTargets.
    const content = join(directory, "content.bin");
    writeFileSync(content, "content");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        join(root, "scripts/smoke_narrative_worker.ts"),
        join(root, "packages/evals/src/metrics/narrative_worker.ts"),
        content,
        "--root",
        root,
        "--compile",
        "--outfile",
        executable,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [buildCode, buildError] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect({ code: buildCode, error: buildCode === 0 ? "" : buildError }).toEqual({
      code: 0,
      error: "",
    });

    const run = Bun.spawn([executable], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(output.trim()).toBe("Narrative worker smoke passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
