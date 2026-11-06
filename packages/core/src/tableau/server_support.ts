/**
 * Which Tableau Server releases the tool can evaluate, and how to say so.
 * Endpoint availability by Tableau Server release.
 *
 * Every evaluation goes through the server's AI endpoint (the generations
 * endpoint under `/content-exploration`), which Tableau Server gained in
 * release 2026.3. Earlier releases sign in and publish fine, so a connection
 * to one is worth keeping (results can still be published to it), but no
 * suite can run against it. This module is the one place that knows the
 * minimum release and the wording for the three ways an endpoint can be
 * missing, so the connection test, the suite catalog, the run request and
 * the per-case errors of a run all explain it the same way.
 *
 * The endpoint can be absent for three reasons that look alike to a runner:
 *
 * - the release is earlier than 2026.3 (HTTP 404: the route does not exist);
 * - the build does not enable the endpoint (HTTP 401 from a signed-in
 *   session: an engineering release flag, not a site setting);
 * - the site's model is not configured or its gateway is failing (HTTP 5xx).
 */

/** The first release with the generations endpoint ("2026.3"). */
export function configuredMinRelease(raw = process.env.TABLEAU_AI_EVAL_MIN_RELEASE ?? ""): readonly [number, number] {
  const match = /^(\d{4})\.(\d{1,2})$/.exec(raw.trim());
  return match ? [Number(match[1]), Number(match[2])] : [2026, 3];
}
export const MIN_RELEASE = configuredMinRelease();
export const MIN_RELEASE_LABEL = `${MIN_RELEASE[0]}.${MIN_RELEASE[1]}`;

const RELEASE_RE = /^\s*(\d{4})\.(\d{1,2})(?:\.\d+)?/;

/**
 * `"2025.3.1"` → `[2025, 3]`; a development build (`"0.0.0"`) or an
 * unreadable string → null, meaning "unknown", never "too old".
 */
export function parseRelease(productVersion: unknown): [number, number] | null {
  if (!productVersion) return null;
  const m = RELEASE_RE.exec(String(productVersion));
  if (!m) return null;
  const year = Number(m[1]);
  const minor = Number(m[2]);
  if (year < 2000) return null; // "0.0.0" and other placeholders
  return [year, minor];
}

/**
 * True when the version names a release earlier than 2026.3, false when it
 * names 2026.3 or later, null when the version does not say (development
 * builds report "0.0.0" and have the endpoint).
 */
export function releaseBeforeMinimum(productVersion: unknown): boolean | null {
  const release = parseRelease(productVersion);
  if (release === null) return null;
  return release[0] < MIN_RELEASE[0] || (release[0] === MIN_RELEASE[0] && release[1] < MIN_RELEASE[1]);
}

/** The release as the admin knows it: "2025.3", or "this release" when the version does not say. */
export function releaseLabel(productVersion: unknown): string {
  const release = parseRelease(productVersion);
  if (release === null) return "this release";
  return `${release[0]}.${release[1]}`;
}

/** Why the suites are disabled, and what to do about it. */
export function tooOldMessage(productVersion: unknown): string {
  const version = releaseLabel(productVersion);
  const which = version !== "this release" ? `Tableau Server ${version}` : "This Tableau Server";
  return (
    `${which} is earlier than ${MIN_RELEASE_LABEL}, the first release with the ` +
    "AI endpoint the tool evaluates through, so the test suites are disabled. " +
    `Upgrade the server to ${MIN_RELEASE_LABEL} or later, then test the connection ` +
    "again. Results already on this computer can still be viewed, exported and " +
    "published to this server."
  );
}

/**
 * A run's own words for a 404 from the endpoint (the release check at
 * connection time did not catch it, say because the connection was tested
 * before the server was downgraded or re-pointed).
 */
export function endpointMissingMessage(url: string): string {
  return (
    `Tableau Server has no AI endpoint at ${url} (HTTP 404), so its release is ` +
    `earlier than ${MIN_RELEASE_LABEL}. Upgrade the server to ${MIN_RELEASE_LABEL} or ` +
    "later and test the connection again before evaluating."
  );
}

export const FLAG_OFF_MESSAGE =
  "This Tableau Server build does not enable the AI endpoint the tool needs, " +
  "so evaluations can't run through it. A server release controls the endpoint, " +
  "not a site setting. Ask your Tableau admin which release the server runs.";

export const GATEWAY_DISABLED_TEXT = "llm gateway is disabled";
export const GATEWAY_DISABLED_MESSAGE =
  'This site\'s LLM gateway is turned off (the server answered "LLM Gateway is disabled"), ' +
  "so suites that send requests through Tableau's generic AI endpoint cannot run here. " +
  "The suites that ship with the tool use their own endpoints and are not affected; only " +
  "Direct-gateway evaluation and the Prep bench's prompt-only path need the gateway. Ask " +
  "your Tableau admin to turn the LLM gateway on for the site if you need those.";

/** Python's `str.strip()[:200]` on a response body. */
function snippetOf(body: string | null | undefined): string {
  return (body ?? "").trim().slice(0, 200);
}

/** A 5xx from the endpoint after the retries: the server's own model or gateway, not the connection. */
export function gatewayFailureMessage(statusCode: number, body: string | null | undefined): string {
  const snippet = snippetOf(body);
  return (
    `The site's AI model did not answer (Tableau Server returned HTTP ${statusCode}` +
    `${snippet ? `: ${snippet}` : ""}). The connection to the server works; the ` +
    "model or its gateway does not. Test it in Site Settings > AI in Tableau, " +
    "then resume the evaluation."
  );
}

/** Any other 4xx from the endpoint. */
export function refusedMessage(statusCode: number, body: string | null | undefined): string {
  const snippet = snippetOf(body);
  return (
    `Tableau Server refused the AI request (HTTP ${statusCode}` +
    `${snippet ? `: ${snippet}` : ""}). Test the connection in Evaluation Setup, ` +
    "step 1; if the test passes, ask your Tableau admin whether the account " +
    "has the AI features enabled."
  );
}

/** The endpoint did not answer at all, after the retries. */
export function unreachableMessage(url: string, detail: string): string {
  return (
    `Tableau Server did not answer at ${url} (${detail}). Check that this computer ` +
    "still reaches the server (VPN, network), then resume the evaluation."
  );
}
