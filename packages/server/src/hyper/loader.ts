/** Lazy native loading: installed npm package in dev, verified npm cache in releases. */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureReleasePackage } from "./download.ts";
import { hyperdBinaryName, nativeNodeFileName, platformTag, resolveNativeNodePath } from "./platform.ts";

type PackageApi = typeof import("hyperdb-api-node");
// The declaration uses ambient const enums, but the addon exposes real runtime objects.
export type HyperApi = Omit<PackageApi, "CreateMode"> & {
  CreateMode: { [K in "CreateAndReplace" | "Create" | "CreateIfNotExists" | "DoNotCreate"]: Parameters<PackageApi["Connection"]["connect"]>[2] };
};
const nodeRequire = createRequire(import.meta.url);
let loaded: HyperApi | undefined;
let hyperdPath: string | null = null;
let pending: Promise<HyperApi> | undefined;

function isStandalone(): boolean {
  return Bun.isStandaloneExecutable;
}

/** Synchronous schema helpers must be called after loadHyper(). */
export function loadedHyper(): HyperApi {
  if (!loaded) throw new Error("Hyper has not been initialized; await loadHyper() first.");
  return loaded;
}

export function getHyperdPath(): string | null {
  const override = process.env.HYPERD_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`HYPERD_PATH does not exist: ${override}`);
    return override;
  }
  return hyperdPath;
}

export function loadHyper(): Promise<HyperApi> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  pending = initialize().catch((error) => {
    pending = undefined; // A later publish can retry after a failed download.
    throw error;
  });
  return pending;
}

async function initialize(): Promise<HyperApi> {
  const tag = platformTag();
  if (!tag) throw new Error(`Hyper is not supported on ${process.platform}-${process.arch}.`);
  const nativePath = isStandalone()
    ? join(await ensureReleasePackage(tag), nativeNodeFileName(tag))
    : resolveNativeNodePath(tag);
  if (!nativePath) throw new Error("Hyper native package is not installed. Run bun install first.");
  // Computed createRequire deliberately prevents --compile from embedding the addon.
  const api = nodeRequire(nativePath) as HyperApi;
  Object.defineProperty(api.QueryStream.prototype, Symbol.asyncIterator, { configurable: true, value: async function* (this: InstanceType<HyperApi["QueryStream"]>) {
    let chunk = await this.nextChunk();
    while (chunk !== null) {
      for (const row of chunk) yield row;
      chunk = await this.nextChunk();
    }
  } });
  api.Connection.prototype[Symbol.asyncDispose] = function () { return this.close(); };
  Object.defineProperty(api.HyperProcess.prototype, Symbol.dispose, { configurable: true, value: function (this: InstanceType<HyperApi["HyperProcess"]>) { this.close(); } });
  hyperdPath = join(dirname(nativePath), hyperdBinaryName());
  if (!existsSync(hyperdPath)) throw new Error(`Hyper server executable is missing: ${hyperdPath}`);
  loaded = api;
  return api;
}
