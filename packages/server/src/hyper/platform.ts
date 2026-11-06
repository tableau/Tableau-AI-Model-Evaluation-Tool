/**
 * Platform → hyperdb-api-node package/tag resolution (shared by the loader and
 * the build script). The npm platform package is `hyperdb-api-node-<tag>` and
 * the native file inside it is `hyperdb-api-node.<tag>.node`.
 *
 * Mirrors hyperdb-api-node/index.js getPlatformPackage(). Musl (Alpine) is
 * detected best-effort; the common glibc case is the default on Linux.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** True on musl libc (Alpine). Best-effort, mirrors the package's own check. */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    // Node/Bun report glibc in process.report on glibc systems.
    const rep = (process as unknown as { report?: { getReport?: () => unknown } })
      .report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    if (rep?.header && !rep.header.glibcVersionRuntime) return true;
  } catch {
    /* fall through */
  }
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
  } catch {
    return false;
  }
}

/**
 * The hyperdb-api-node platform tag for the given (or current) platform, e.g.
 * `darwin-arm64`, `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`,
 * `win32-x64-msvc`. Returns null for an unsupported platform.
 */
export function platformTag(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  switch (platform) {
    case "darwin":
      // The pinned Hyper npm package is available only for macOS arm64.
      return arch === "arm64" ? "darwin-arm64" : null;
    case "linux": {
      const libc = isMusl() ? "musl" : "gnu";
      if (arch === "arm64") return `linux-arm64-${libc}`;
      return `linux-x64-${libc}`;
    }
    case "win32":
      return arch === "x64" ? "win32-x64-msvc" : null;
    default:
      return null;
  }
}

/** npm package name for a tag: hyperdb-api-node-<tag>. */
export function platformPackage(tag: string): string {
  return `hyperdb-api-node-${tag}`;
}

/** The `.node` filename inside the platform package for a tag. */
export function nativeNodeFileName(tag: string): string {
  return `hyperdb-api-node.${tag}.node`;
}

/**
 * Absolute path to the installed platform `.node` addon for a tag, resolved via
 * Node module resolution from THIS module (so it works regardless of whether
 * the dependency is hoisted to the repo-root `node_modules`, nested under
 * `packages/server/node_modules`, or symlinked from Bun's `.bun` store).
 * Returns null if the platform package is not installed/resolvable.
 */
export function resolveNativeNodePath(tag: string): string | null {
  const req = createRequire(import.meta.url);
  const pkg = platformPackage(tag);
  const fileName = nativeNodeFileName(tag);
  // Try resolving the platform package directly from here first.
  const tryResolve = (fromRequire: NodeJS.Require): string | null => {
    try {
      const pkgJson = fromRequire.resolve(`${pkg}/package.json`);
      const candidate = join(dirname(pkgJson), fileName);
      return existsSync(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };
  const direct = tryResolve(req);
  if (direct) return direct;
  // Fallback: the platform package is an optionalDependency of
  // `hyperdb-api-node` and (under Bun's store / non-hoisted workspaces) is only
  // reachable from that package's own location, not ours. Resolve it relative
  // to `hyperdb-api-node`.
  try {
    const hostPkgJson = req.resolve("hyperdb-api-node/package.json");
    const hostRequire = createRequire(hostPkgJson);
    const viaHost = tryResolve(hostRequire);
    if (viaHost) return viaHost;
    // Some layouts nest the platform package under the host's node_modules.
    const nested = join(
      dirname(hostPkgJson),
      "node_modules",
      pkg,
      fileName,
    );
    if (existsSync(nested)) return nested;
  } catch {
    /* fall through */
  }
  return null;
}

/** The `hyperd` server binary name for a platform. */
export function hyperdBinaryName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "hyperd.exe" : "hyperd";
}
