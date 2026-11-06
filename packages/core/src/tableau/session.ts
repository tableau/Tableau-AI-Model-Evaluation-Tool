/**
 * Tableau Server session manager.
 *
 * PAT → session token via `POST /api/{version}/auth/signin`, with the two
 * resilience behaviors the runners never had together:
 *
 * - **Proactive refresh**: tokens are re-minted after 15 minutes
 *   (TOKEN_REFRESH_THRESHOLD_S), because session tokens have idle/absolute
 *   timeouts shorter than a full suite run.
 * - **Reactive invalidation**: on a 401 the caller invalidates and re-signs in
 *   once (`handle401`); if the re-signin itself is refused, the PAT is dead —
 *   `onAuthFailure` fires so the run can auto-pause instead of failing every
 *   remaining case.
 *
 * ## Concurrent signins
 *
 * Bun's JS runtime is single-threaded with a
 * cooperative event loop, so there is no preemptive interleaving to guard
 * against. The only concurrency hazard is *re-entrancy*: two overlapping
 * `await getToken()` calls could each kick off a signin while the first is
 * still awaiting `fetch`. We collapse that with an **in-flight promise cache**
 * (`_signinInFlight`): the first caller starts the signin, later callers await
 * the same promise. This is the async analogue of the lock — it serializes
 * concurrent signins to a single network round-trip — without needing a mutex.
 *
 * ## TLS verification (self-signed / internal certs)
 *
 * The `verify` flag maps to Bun's per-request `fetch` option
 * `{ tls: { rejectUnauthorized: false } }` when `verify === false`. This is the
 * Bun-supported mechanism for disabling TLS chain verification on a single
 * request (verified against a self-signed host: with verify on, Bun throws
 * `DEPTH_ZERO_SELF_SIGNED_CERT`; with it off, the request succeeds). We do NOT
 * touch the process-global `NODE_TLS_REJECT_UNAUTHORIZED` — a per-request flag
 * is scoped and does not weaken TLS for every other fetch in the process.
 *
 * A gentler alternative to disabling verification is a **custom CA bundle**:
 * pass `caBundlePath` (from env `TABLEAU_AI_EVAL_CA_BUNDLE` or `~/.tableau-ai-eval/ca.pem`) and,
 * with `verify` left ON, Bun trusts that private CA while still authenticating
 * the connection. The `{verify, caBundlePath}` pair is turned into the Bun
 * `tls` object by {@link tlsInit} (see src/tableau/tls.ts). `caBundlePath` is
 * threaded in from the edge — this module never reads env itself.
 */

import { tlsInit } from "./tls.ts";

const TOKEN_REFRESH_THRESHOLD_MS = 15 * 60 * 1000;
const SIGNIN_TIMEOUT_MS = 30_000;

/** The PAT (or site) was refused — re-signin cannot recover this. */
export class TableauAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableauAuthError";
  }
}

/** Injectable fetch (defaults to the global) — lets tests mock the network. */
export type FetchLike = typeof fetch;
/** Injectable monotonic clock (ms) — lets tests advance time deterministically. */
export type ClockLike = () => number;

export interface TableauSessionOptions {
  serverUrl: string;
  patName: string;
  patSecret: string;
  siteContentUrl?: string;
  apiVersion?: string;
  /** TLS chain verification; false disables it (self-signed/internal certs). */
  verify?: boolean;
  /**
   * PEM CA bundle path to trust when `verify` is true (private/self-signed CA).
   * Threaded from the edge (env `TABLEAU_AI_EVAL_CA_BUNDLE` / `~/.tableau-ai-eval/ca.pem`).
   */
  caBundlePath?: string;
  onAuthFailure?: (reason: string) => void;
  /** Test seams. */
  fetchImpl?: FetchLike;
  clock?: ClockLike;
}

export class TableauSession {
  private readonly _serverUrl: string;
  private readonly _patName: string;
  private readonly _patSecret: string;
  private readonly _site: string;
  private readonly _apiVersion: string;
  private readonly _verify: boolean;
  private readonly _caBundlePath?: string;
  private readonly _onAuthFailure?: (reason: string) => void;
  private readonly _fetch: FetchLike;
  private readonly _now: ClockLike;

  private _token: string | null = null;
  private _siteId: string | null = null;
  private _mintedAt = 0;
  /** In-flight signin promise — the async analogue of the Python lock. */
  private _signinInFlight: Promise<string> | null = null;
  private _activeConversations = 0;

  constructor(opts: TableauSessionOptions) {
    this._serverUrl = opts.serverUrl.replace(/\/+$/, "");
    this._patName = opts.patName;
    this._patSecret = opts.patSecret;
    this._site = opts.siteContentUrl ?? "";
    this._apiVersion = opts.apiVersion ?? "3.22";
    this._verify = opts.verify ?? true;
    this._caBundlePath = opts.caBundlePath;
    this._onAuthFailure = opts.onAuthFailure;
    this._fetch = opts.fetchImpl ?? fetch;
    this._now = opts.clock ?? (() => Date.now());
  }

  get serverUrl(): string {
    return this._serverUrl;
  }

  get apiVersion(): string {
    return this._apiVersion;
  }

  /**
   * The site LUID from the signin response — REST API paths need it.
   * Signing in populates it; access before first signin triggers one.
   */
  async siteId(): Promise<string | null> {
    if (this._siteId === null) {
      await this.getToken();
    }
    return this._siteId;
  }

  /** The last-seen site LUID without triggering a signin (may be null). */
  get cachedSiteId(): string | null {
    return this._siteId;
  }

  // -- token lifecycle ------------------------------------------------------

  /** Return a session token, re-signing in proactively after 15 min. */
  async getToken(): Promise<string> {
    // A proactive refresh can leave the previous token cached while signin is
    // pending. Never hand that token to a new conversation during the refresh.
    if (this._signinInFlight !== null) return this._signinInFlight;
    if (
      this._token !== null &&
      (this._activeConversations > 0 || this._now() - this._mintedAt < TOKEN_REFRESH_THRESHOLD_MS)
    ) {
      return this._token;
    }
    // Coalesce concurrent signins to a single network round-trip.
    const inflight = this._signin().finally(() => {
      this._signinInFlight = null;
    });
    this._signinInFlight = inflight;
    return inflight;
  }

  invalidate(): void {
    this._token = null;
  }

  /** Hold a token for a conversation; defer proactive refresh until all holders
   * finish. Reactive 401 recovery still replaces an invalidated token.
   * Release before retry backoff, and always release in a finally block.
   */
  async acquireConversationToken(): Promise<{ token: string; release: () => void }> {
    const pending = this.getToken();
    this._activeConversations++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this._activeConversations--;
    };
    try {
      return { token: await pending, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Reactive-401 path: drop the cached token and sign in again, at most once
   * per lost session however many concurrent requests saw the same 401.
   *
   * A Personal Access Token supports one live session, so a sign-in ends the
   * previous one. With several requests in flight, all of them see the 401 at
   * once; if the cached token already differs from the one that failed
   * (`failedToken`), another caller has re-signed in first, and its token is
   * returned instead of signing in yet again (which would end *that* session
   * too, and so on). Callers that pass no `failedToken` always re-sign in.
   *
   * Throws {@link TableauAuthError} (after firing `onAuthFailure`) when the
   * re-signin is itself refused — the PAT is revoked or expired and no amount
   * of retrying will help.
   */
  async handle401(failedToken?: string | null): Promise<string> {
    if (
      failedToken != null &&
      this._token !== null &&
      this._token !== failedToken
    ) {
      // Another in-flight request already minted a fresh token — reuse it.
      return this._token;
    }
    this.invalidate();
    return this.getToken();
  }

  async authHeaders(): Promise<Record<string, string>> {
    return { "X-Tableau-Auth": await this.getToken() };
  }

  // -- internals ------------------------------------------------------------

  private async _signin(): Promise<string> {
    const url = `${this._serverUrl}/api/${this._apiVersion}/auth/signin`;
    const init: RequestInit & { tls?: unknown } = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        credentials: {
          personalAccessTokenName: this._patName,
          personalAccessTokenSecret: this._patSecret,
          site: { contentUrl: this._site },
        },
      }),
      signal: AbortSignal.timeout(SIGNIN_TIMEOUT_MS),
      // Bun-supported per-request TLS handling: disable verification when
      // `verify` is false, or trust a private CA bundle when configured.
      ...tlsInit({ verify: this._verify, caBundlePath: this._caBundlePath }),
    };

    let resp: Response;
    try {
      resp = await this._fetch(url, init);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      throw new Error(
        `Could not reach Tableau Server at ${this._serverUrl} to sign in ` +
          `(${msg}). Check the address, the VPN and the network, then try again.`,
      );
    }

    if (resp.status === 401 || resp.status === 403) {
      const reason =
        `Tableau Server didn't accept the PAT (${resp.status}): the personal ` +
        "access token isn't valid or has expired";
      this._token = null;
      if (this._onAuthFailure) {
        try {
          this._onAuthFailure(reason);
        } catch {
          // callback errors must not mask the auth error
        }
      }
      throw new TableauAuthError(reason);
    }
    if (resp.status !== 200) {
      const text = await this._safeText(resp);
      throw new Error(
        `Tableau Server answered the sign-in with HTTP ${resp.status} ` +
          `(${text.slice(0, 200).trim()}). Try again; if it keeps failing, ask ` +
          "your Tableau admin whether the server is healthy.",
      );
    }

    let token: string;
    let siteId: string | null;
    try {
      const body = (await resp.json()) as {
        credentials?: { token?: string; site?: { id?: string } };
      };
      const creds = body.credentials;
      if (!creds || typeof creds.token !== "string") {
        throw new Error("missing credentials.token");
      }
      token = creds.token;
      siteId = creds.site?.id ?? null;
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      throw new Error(
        "Tableau Server's sign-in answer was not in the expected form " +
          `(${msg}). Check that the address is the Tableau Server itself, not ` +
          "a sign-in page or proxy in front of it.",
      );
    }

    this._token = token;
    this._siteId = siteId;
    this._mintedAt = this._now();
    return token;
  }

  private async _safeText(resp: Response): Promise<string> {
    try {
      return await resp.text();
    } catch {
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// One session per run, shared by everything in the process that signs in with
// the run's PAT.
//
// Shared session registry. Before this,
// the embedded CES bridge and the harness runner each built their own
// TableauSession for the same PAT, and each sign-in ended the other's session
// (a PAT supports one live session): in a live run 53 gateway calls minted 31
// tokens (bug bash 2026-09-23). The orchestrator registers the run's session
// here (share) and the harness runner adopts it (shared) so both use one token.
// ---------------------------------------------------------------------------

const _SHARED = new Map<string, TableauSession>();

/** Register the session everything in this run should sign in with. */
export function shareSession(jobId: string, session: TableauSession): void {
  _SHARED.set(jobId, session);
}

/** The run's shared session, if one was registered (null otherwise). */
export function sharedSession(jobId: string | null | undefined): TableauSession | null {
  return jobId ? (_SHARED.get(jobId) ?? null) : null;
}

/** Forget the run's shared session (called in the orchestrator's finally). */
export function unshareSession(jobId: string): void {
  _SHARED.delete(jobId);
}
