/**
 * CLI tests — argument parsing + `version` output (no port binding for serve).
 */

import { describe, expect, it } from "bun:test";
import { main, trust } from "./cli.ts";
import { VERSION } from "./app.ts";

describe("tableau-ai-eval CLI", () => {
  it("version returns 0 and prints the version", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      const code = main(["version"]);
      expect(code).toBe(0);
      expect(writes.join("")).toContain(VERSION);
    } finally {
      (process.stdout.write as unknown) = orig;
    }
  });

  it("no command prints help with exit code 2", () => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = () => true;
    try {
      const code = main([]);
      expect(code).toBe(2);
    } finally {
      (process.stdout.write as unknown) = orig;
    }
  });

  it("help lists the trust and --allow-self-signed capabilities", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      main([]);
      const help = writes.join("");
      expect(help).toContain("tableau-ai-eval trust <server-url>");
      expect(help).toContain("--allow-self-signed");
    } finally {
      (process.stdout.write as unknown) = orig;
    }
  });

  it("trust with no target returns exit code 2 (offline usage error)", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = () => true;
    try {
      const code = await trust([]);
      expect(code).toBe(2);
    } finally {
      (process.stderr.write as unknown) = orig;
    }
  });
});
