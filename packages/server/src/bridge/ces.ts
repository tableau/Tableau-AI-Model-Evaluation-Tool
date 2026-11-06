/**
 * Embedded EGPT→CES bridge.
 *
 * Forwards EGPT-format requests to Tableau CES's prompt-based
 * `POST /analytics-assistant/v1/generations` endpoint, authenticating with a
 * {@link TableauSession} (reused from `src/tableau/session.ts`) via the
 * `X-Tableau-Auth` header. The CES reply is re-wrapped into the EGPT chat shape
 * runners already parse.
 *
 * Exports:
 *  - pure helpers `flattenMessages` / `wrapChatResponse`,
 *  - `CesBridge` — the forwarder (with an injectable `fetchImpl` + optional
 *    session), exposing `handle(req)` (Request → Response) and `start()`/`stop()`.
 *
 * ## Wire contract
 *
 * CES `POST /analytics-assistant/v1/generations` is PROMPT-based:
 *   request  `{ prompt, model, temperature }`
 *   response top-level `generations[0].text` with usage under `parameters.usage`.
 * No streaming. The `model` field is currently discarded server-side but is
 * forwarded anyway so a future CES fix honors it.
 *
 * Two inbound routes:
 *  - `POST /v1.0/chat/generations`: chat messages
 *    are flattened (system contents then non-system contents, joined by "\n\n"),
 *    and the CES reply is re-wrapped into `generation_details.generations[0].content`.
 *  - `POST /v1.0/generations` (Prep): near-passthrough — same
 *    request/response shape; the CES `.generations[0].text` reply is returned as-is.
 *
 * ## Resilience
 *
 * Retry policy: 3 attempts, exponential 5–30s + 0–2s
 * jitter on 429/5xx/network; a 401 triggers one session invalidate + re-signin
 * retry, then propagates. We reproduce the retry *policy* (retry classes,
 * attempt count, and the 401→handle401→retry-once path) with a small util.
 *
 * Retry timing: production waits 5–30s between attempts. For
 * an offline/embedded bridge those real sleeps are undesirable in tests and
 * add nothing to wire-format fidelity, so the wait is injectable
 * (`retryDelayMs`, default 0 in tests / a backoff in production). No
 * behavioral wire difference, only timing.
 */

import {
  FLAG_OFF_MESSAGE,
  TableauAuthError,
  TableauSession,
  endpointMissingMessage,
  gatewayFailureMessage,
  refusedMessage,
  tlsInit,
  unreachableMessage,
} from "@tableau-ai-eval/core";

export type FetchLike = typeof fetch;

export interface ChatMessage {
  role: string;
  content: string;
}

export const CES_GENERATIONS_PATH = "/analytics-assistant/v1/generations";
export const REQUEST_TIMEOUT_MS = 120_000; // matches the WAII reference client
const MAX_ATTEMPTS = 3;
/** Cap on the exponential retry wait, matching the documented 5–30s intent. */
export const MAX_RETRY_DELAY_MS = 30_000;
/** Production backoff base (5–30s exponential). */
export const DEFAULT_RETRY_DELAY_MS = 5_000;

/** Transient CES failure (network, 5xx, 429) — worth retrying. */
export class RetryableCesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableCesError";
  }
}

/**
 * Chat messages → single prompt, exactly as the WAII client does: system-role
 * contents first, then everything else, joined by blank lines. Empty parts are
 * dropped. Mirrors `flatten_messages`.
 */
export function flattenMessages(messages: ChatMessage[]): string {
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "");
  const userParts = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content ?? "");
  return [...systemParts, ...userParts].filter((p) => p).join("\n\n");
}

export interface EgptChatResponse {
  generation_details: {
    generations: Array<{
      content: string;
      role: string;
      parameters: { finish_reason: string };
    }>;
    parameters: {
      model: string;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
  };
}

/**
 * CES prompt-response → EGPT chat shape consumed by the runners.
 */
export interface CesResponse {
  generations?: ({ text?: string | null; parameters?: { finish_reason?: string | null } | null } | null)[];
  parameters?: { usage?: { prompt_tokens?: number; completion_tokens?: number } | null } | null;
}

export function wrapChatResponse(cesData: CesResponse | null | undefined, model: string): EgptChatResponse {
  const generations = cesData?.generations ?? [];
  const first = generations.length > 0 ? generations[0] : {};
  const text = first?.text ?? "";
  const finishReason = (first?.parameters ?? {}).finish_reason ?? "stop";
  const usage = (cesData?.parameters ?? {}).usage ?? {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    generation_details: {
      generations: [
        {
          content: text,
          role: "assistant",
          parameters: { finish_reason: finishReason },
        },
      ],
      parameters: {
        model,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      },
    },
  };
}

export interface CesBridgeOptions {
  cesHost: string;
  session?: TableauSession;
  /** TLS chain verification; false disables it (self-signed dev CES). */
  verify?: boolean;
  /** PEM CA bundle path to trust when verify is true (private/enterprise CA). */
  caBundlePath?: string;
  fetchImpl?: FetchLike;
  /** Delay between retry attempts (ms). Default 0 (see module FLAG). */
  retryDelayMs?: number;
  signal?: AbortSignal;
}

/**
 * One bridge per run: constructed with the CES host and an optional
 * TableauSession (omitted only for local-dev CES with its query-param
 * backdoor, which needs no session header).
 */
export class CesBridge {
  private readonly _cesUrl: string;
  private readonly _session?: TableauSession;
  private readonly _verify: boolean;
  private readonly _caBundlePath?: string;
  private readonly _fetch: FetchLike;
  private readonly _retryDelayMs: number;
  private readonly _signal?: AbortSignal;
  private _server: ReturnType<typeof Bun.serve> | null = null;
  baseUrl: string | null = null;

  constructor(opts: CesBridgeOptions) {
    this._cesUrl = opts.cesHost.replace(/\/+$/, "") + CES_GENERATIONS_PATH;
    this._session = opts.session;
    this._verify = opts.verify ?? true;
    this._caBundlePath = opts.caBundlePath;
    this._fetch = opts.fetchImpl ?? fetch;
    this._retryDelayMs = opts.retryDelayMs ?? 0;
    this._signal = opts.signal;
  }

  get cesUrl(): string {
    return this._cesUrl;
  }

  /** Effective per-attempt retry backoff base (ms). Exposed for tests. */
  get retryDelayMs(): number {
    return this._retryDelayMs;
  }

  // -- outbound -------------------------------------------------------------

  private async _postCes(
    payload: Record<string, unknown>,
    token?: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token != null) {
      headers["X-Tableau-Auth"] = token;
    } else if (this._session) {
      Object.assign(headers, await this._session.authHeaders());
    }
    const init: RequestInit & { tls?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Same TLS ergonomics as TableauSession: verify=false disables the chain,
      // verify=true + caBundlePath trusts a private CA, else system trust.
      ...tlsInit({ verify: this._verify, caBundlePath: this._caBundlePath }),
    };
    try {
      return await this._fetch(this._cesUrl, init);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      throw new RetryableCesError(`network error: ${msg}`);
    }
  }

  /**
   * Forward one prompt to CES with the retry/401 policy from `_forward`.
   * Throws {@link TableauAuthError} on unrecoverable auth, {@link RetryableCesError}
   * on exhausted transient retries, and a plain Error on 4xx.
   */
  async forward(
    prompt: string,
    model: string,
    temperature: number,
  ): Promise<CesResponse> {
    const payload = { prompt, model, temperature };
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this._signal?.throwIfAborted();
      try {
        const token = this._session ? await this._session.getToken() : null;
        let resp = await this._postCes(payload, token);
        if (resp.status === 401 && this._session) {
          // Reactive path: re-sign in once for this lost token (concurrent
          // callers that saw the same 401 reuse the new token), then retry.
          // handle401 raises TableauAuthError → auto-pause when the PAT is dead.
          resp = await this._postCes(payload, await this._session.handle401(token));
        }
        if (resp.status === 429 || resp.status >= 500) {
          const text = await resp.text().catch(() => "");
          throw new RetryableCesError(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        if (resp.status >= 400) {
          const text = await resp.text().catch(() => "");
          throw new Error(this._explain(resp.status, text));
        }
        return await resp.json() as CesResponse;
      } catch (exc) {
        this._signal?.throwIfAborted();
        // TableauAuthError and non-retryable errors propagate immediately.
        if (exc instanceof TableauAuthError) {
          throw exc;
        }
        if (!(exc instanceof RetryableCesError)) {
          throw exc;
        }
        lastErr = exc;
        if (attempt < MAX_ATTEMPTS && this._retryDelayMs > 0) {
          // Exponential backoff (base * 2^(attempt-1)), capped, matching the
          // documented tenacity 5–30s intent. Tests inject 0 for instant retry.
          const delay = Math.min(
            this._retryDelayMs * 2 ** (attempt - 1),
            MAX_RETRY_DELAY_MS,
          );
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(this._signal?.reason); };
            const timer = setTimeout(() => {
              this._signal?.removeEventListener("abort", abort);
              resolve();
            }, delay);
            this._signal?.addEventListener("abort", abort, { once: true });
          });
        }
      }
    }
    throw lastErr;
  }

  /**
   * The per-case error an admin reads when the endpoint refuses a request:
   * what it means and what to do, not a bare status line. Same wording as the
   * connection test for the same condition.
   */
  private _explain(status: number, body: string): string {
    if (status === 404) return endpointMissingMessage(this._cesUrl);
    // The session was renewed on the first 401 (above), so a second one is
    // the endpoint itself: the build does not enable it.
    if (status === 401) return FLAG_OFF_MESSAGE;
    return refusedMessage(status, body);
  }

  /** After the retries: the gateway behind the endpoint, or the network. */
  private _explainExhausted(exc: RetryableCesError): string {
    let text = exc.message;
    const m = /^HTTP (\d{3}): ?([\s\S]*)$/.exec(text);
    if (m) return gatewayFailureMessage(Number(m[1]), m[2] ?? "");
    if (text.startsWith("network error: ")) text = text.slice("network error: ".length);
    return unreachableMessage(this._cesUrl, text);
  }

  // -- inbound handler ------------------------------------------------------

  /**
   * `Request` → `Response` handler for the two inbound routes. Suitable as the
   * `fetch` handler for `Bun.serve`.
   */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      return this._json({ message: "method not allowed" }, 405);
    }

    let body: Record<string, unknown>;
    try {
      body = ((await req.json()) as Record<string, unknown>) ?? {};
    } catch {
      body = {};
    }

    if (path === "/v1.0/chat/generations") {
      const prompt = flattenMessages((body.messages as ChatMessage[]) ?? []);
      const model = (body.model as string) ?? "";
      try {
        const cesData = await this.forward(
          prompt,
          model,
          (body.temperature as number) || 0.0,
        );
        return Response.json(wrapChatResponse(cesData, model));
      } catch (exc) {
        return this._forwardError(exc);
      }
    }

    if (path === "/v1.0/generations") {
      try {
        const cesData = await this.forward(
          (body.prompt as string) ?? "",
          (body.model as string) ?? "",
          (body.temperature as number) || 0.0,
        );
        // Same shape prep already parses (.generations[0].text) — passthrough.
        return Response.json(cesData);
      } catch (exc) {
        return this._forwardError(exc);
      }
    }

    return this._json({ message: "not found" }, 404);
  }

  private _forwardError(exc: unknown): Response {
    if (exc instanceof TableauAuthError) {
      return this._json({ message: exc.message }, 401);
    }
    if (exc instanceof RetryableCesError) {
      // The retries are spent: the gateway behind the endpoint or the network,
      // explained for the case's error column.
      return this._json({ message: this._explainExhausted(exc) }, 502);
    }
    const msg = exc instanceof Error ? exc.message || exc.name : String(exc);
    return this._json({ message: msg }, 502);
  }

  private _json(obj: unknown, status: number): Response {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Bind 127.0.0.1 on an ephemeral port (0) and serve. Returns the base URL
   * runners should use as their gateway.
   */
  start(): string {
    this._server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handle(req),
    });
    this.baseUrl = `http://127.0.0.1:${this._server.port}`;
    return this.baseUrl;
  }

  stop(): void {
    if (this._server) {
      this._server.stop(true);
      this._server = null;
    }
    this.baseUrl = null;
  }
}
