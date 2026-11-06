/**
 * `tableau-ai-eval trust` support — capture a server's TLS certificate chain and write it
 * as a PEM CA bundle (default `~/.tableau-ai-eval/ca.pem`), so operators can trust a
 * self-signed / private-CA Tableau Server WITHOUT disabling verification.
 *
 * ## How the chain is captured (Bun 1.4.2 native API)
 *
 * Bun's TLS `Socket` (from `Bun.connect({ tls: true })`) exposes the peer
 * certificate via Node-compatible methods:
 *   - `socket.getPeerX509Certificate()` → a `node:crypto` `X509Certificate`.
 *     `.raw` is the DER bytes and `.toString()` yields PEM. Each cert links to
 *     its issuer via `.issuerCertificate` (walk it to collect the chain).
 *   - `socket.getPeerCertificate()`     → a plain object with `.raw` (DER) and
 *     `.issuerCertificate` for chain walking (fallback shape).
 *
 * We connect, wait for `open` (the handshake has completed by then for a TLS
 * socket), walk the issuer chain, and DER→PEM each cert. We deliberately do NOT
 * fail on an unauthorized cert — capturing a self-signed cert is the whole
 * point — so `rejectUnauthorized:false` is set for the capture socket.
 *
 * ## openssl fallback
 *
 * If the native API is unavailable or yields no cert (older/edge Bun builds),
 * we shell out to `openssl s_client -showcerts -connect host:port </dev/null`
 * and extract the PEM blocks. Documented + guarded; the native path is tried
 * first.
 *
 * The live capture is inherently network-bound, so it is exercised only by the
 * `trust` command — never in `bun:test`. The pure pieces (DER→PEM, out-path
 * resolution, comment headers) are unit-tested.
 *
 * ## Bundle format
 *
 * Each emitted entry is preceded by curl/Mozilla `cacert.pem`-style `# `
 * comment lines (Issuer/Subject/Label/Serial/SHA1+SHA256 fingerprint) derived
 * from the cert's DER. These are cosmetic — ignored by OpenSSL/BoringSSL — but
 * make the bundle human-auditable. See `certComment`.
 */

import { X509Certificate } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Wrap base64 at 64 cols and frame as a PEM CERTIFICATE block. */
export function derToPem(der: Uint8Array | Buffer): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * curl/Mozilla `cacert.pem`-style comment header for one certificate.
 *
 * These `# `-prefixed lines are cosmetic — OpenSSL/BoringSSL ignore everything
 * outside the `-----BEGIN/END CERTIFICATE-----` frames — but they make a bundle
 * human-auditable (which issuer/subject/fingerprint each entry is). We derive
 * every field from the DER via `node:crypto`'s `X509Certificate`, so all capture
 * paths (native/openssl/powershell) get identical comments regardless of source.
 *
 * Conventions: RDNs joined on one line (`CN=… O=… OU=…`); `Label` is the subject
 * CN; `Serial` is the certificate's serial in hex; fingerprints are the SHA1 and
 * SHA256 colon-separated hex as exposed by X509Certificate. MD5 is intentionally
 * omitted. Returns "" if the DER can't be parsed (comment is best-effort).
 */
export function certComment(der: Uint8Array | Buffer): string {
  let x: X509Certificate;
  try {
    x = new X509Certificate(Buffer.from(der));
  } catch {
    return "";
  }
  // X509Certificate renders multi-RDN subject/issuer with each RDN on its own
  // line; collapse to a single space-separated line like curl's cacert.pem.
  const oneLine = (s: string): string =>
    s
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean)
      .join(" ");
  const cnOf = (s: string): string => {
    for (const r of s.split("\n")) {
      const m = r.trim().match(/^CN=(.*)$/);
      if (m) return m[1];
    }
    return "";
  };
  const lines = [
    `# Issuer: ${oneLine(x.issuer)}`,
    `# Subject: ${oneLine(x.subject)}`,
  ];
  const label = cnOf(x.subject);
  if (label) lines.push(`# Label: ${JSON.stringify(label)}`);
  if (x.serialNumber) lines.push(`# Serial: ${x.serialNumber}`);
  if (x.fingerprint) lines.push(`# SHA1 Fingerprint: ${x.fingerprint}`);
  if (x.fingerprint256) lines.push(`# SHA256 Fingerprint: ${x.fingerprint256}`);
  return lines.join("\n") + "\n";
}

/** Prepend the curl-style comment header (if derivable) to a PEM block. */
function commentedPem(der: Uint8Array | Buffer, pem: string): string {
  const comment = certComment(der);
  return comment ? comment + pem : pem;
}

/**
 * Resolve the output path for the captured bundle.
 * `--out` wins (with leading `~` expansion); default `~/.tableau-ai-eval/ca.pem`.
 */
export function resolveOutPath(
  out: string | undefined,
  home: string = homedir(),
): string {
  if (out && out.trim()) {
    return resolve(out.trim().replace(/^~(?=$|[\\/])/, home));
  }
  return join(home, ".tableau-ai-eval", "ca.pem");
}

/** Parse `<host>[:port]` (or a full URL) into hostname + port (default 443). */
export function parseHostPort(input: string): { hostname: string; port: number } {
  let s = input.trim();
  // Accept full URLs (https://host:port/...).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const u = new URL(s);
    return {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443,
    };
  }
  // Strip any path.
  const slash = s.indexOf("/");
  if (slash >= 0) s = s.slice(0, slash);
  const colon = s.lastIndexOf(":");
  if (colon >= 0 && /^\d+$/.test(s.slice(colon + 1))) {
    return { hostname: s.slice(0, colon), port: Number(s.slice(colon + 1)) };
  }
  return { hostname: s, port: 443 };
}

/**
 * Extract every `-----BEGIN CERTIFICATE-----...` block from text, prepending the
 * curl-style comment header derived from each block's DER (best-effort).
 */
export function extractPemBlocks(text: string): string[] {
  const blocks = text.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (!blocks) return [];
  return blocks.map((b) => {
    const pem = b.trim() + "\n";
    const body = b
      .replace(/-----BEGIN CERTIFICATE-----/, "")
      .replace(/-----END CERTIFICATE-----[\s\S]*/, "")
      .replace(/\s+/g, "");
    let der: Buffer | null = null;
    try {
      der = Buffer.from(body, "base64");
    } catch {}
    return der ? commentedPem(der, pem) : pem;
  });
}

// A minimal structural view of what Bun's X509/peer-cert objects expose.
interface CertLike {
  raw?: Uint8Array | Buffer;
  toString?: () => string;
  issuerCertificate?: CertLike;
  fingerprint256?: string;
}

/** Walk the issuer chain, DER→PEM each cert, dedup by fingerprint/raw. */
function chainToPem(top: CertLike | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: CertLike | null | undefined = top;
  let guard = 0;
  while (cur && guard++ < 16) {
    const key =
      cur.fingerprint256 ??
      (cur.raw ? Buffer.from(cur.raw).toString("base64") : String(guard));
    if (seen.has(key)) break;
    seen.add(key);

    let pem: string | null = null;
    let der: Uint8Array | Buffer | null = null;
    if (cur.raw) {
      der = cur.raw;
      pem = derToPem(cur.raw);
    } else if (typeof cur.toString === "function") {
      const s = cur.toString();
      if (s.includes("BEGIN CERTIFICATE")) {
        pem = s.endsWith("\n") ? s : s + "\n";
        // Recover DER from the PEM body so we can derive the comment header.
        const body = s
          .replace(/-----BEGIN CERTIFICATE-----/, "")
          .replace(/-----END CERTIFICATE-----[\s\S]*/, "")
          .replace(/\s+/g, "");
        try {
          der = Buffer.from(body, "base64");
        } catch {}
      }
    }
    if (pem) out.push(der ? commentedPem(der, pem) : pem);

    const next: CertLike | undefined = cur.issuerCertificate;
    // A self-signed root points issuerCertificate back at itself.
    if (next === cur) break;
    cur = next;
  }
  return out;
}

/**
 * Capture the peer certificate chain from a live TLS endpoint using Bun's
 * native socket API. Resolves to PEM blocks, or an empty array if the native
 * API yielded nothing (caller then tries the openssl fallback).
 */
export async function captureChainNative(
  hostname: string,
  port: number,
): Promise<string[]> {
  return await new Promise<string[]>((resolvePromise) => {
    let settled = false;
    const done = (pems: string[]) => {
      if (settled) return;
      settled = true;
      resolvePromise(pems);
    };
    // 10s ceiling so a black-hole endpoint doesn't hang the CLI.
    const timer = setTimeout(() => done([]), 10_000);

    Bun.connect({
      hostname,
      port,
      // Capture even an untrusted self-signed cert — that's the point.
      tls: { rejectUnauthorized: false } as never,
      socket: {
        open(socket: unknown) {
          try {
            const s = socket as {
              getPeerX509Certificate?: () => CertLike;
              getPeerCertificate?: (detailed?: boolean) => CertLike;
              end?: () => void;
            };
            let pems: string[] = [];
            // Prefer getPeerCertificate(true): the DETAILED form returns the
            // certificate chain the server actually SENT on the wire (leaf +
            // intermediates) via nested `.issuerCertificate`, even when the
            // chain is untrusted. Passing no argument (or getPeerX509Certificate)
            // typically yields only the leaf — which is why Windows, lacking the
            // openssl fallback, captured a single cert.
            if (typeof s.getPeerCertificate === "function") {
              pems = chainToPem(s.getPeerCertificate(true));
            }
            // Fallbacks: undetailed peer cert, then the X509 form.
            if (pems.length === 0 && typeof s.getPeerCertificate === "function") {
              pems = chainToPem(s.getPeerCertificate());
            }
            if (pems.length === 0 && typeof s.getPeerX509Certificate === "function") {
              pems = chainToPem(s.getPeerX509Certificate());
            }
            try {
              s.end?.();
            } catch {}
            clearTimeout(timer);
            done(pems);
          } catch {
            clearTimeout(timer);
            done([]);
          }
        },
        data() {},
        error() {
          clearTimeout(timer);
          done([]);
        },
        close() {
          clearTimeout(timer);
          done([]);
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      done([]);
    });
  });
}

/**
 * openssl fallback: `openssl s_client -showcerts -connect host:port`.
 * Documented fallback for when Bun's native API can't expose the full chain.
 */
export async function captureChainOpenssl(
  hostname: string,
  port: number,
): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      [
        "openssl",
        "s_client",
        "-showcerts",
        "-connect",
        `${hostname}:${port}`,
        "-servername",
        hostname,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return extractPemBlocks(out);
  } catch {
    return [];
  }
}

/**
 * Windows fallback (openssl is usually absent): use PowerShell to open a TLS
 * connection, then build the full chain with .NET's X509Chain — which resolves
 * intermediates/root from the Windows certificate store (an enterprise-CA
 * machine has the issuing CA installed). Emits every cert in the chain as PEM.
 */
export async function captureChainPowershell(
  hostname: string,
  port: number,
): Promise<string[]> {
  if (process.platform !== "win32") return [];
  // PowerShell script: connect, grab the remote cert, build+export the chain.
  const ps = `
$ErrorActionPreference='Stop'
try {
  $c = New-Object System.Net.Sockets.TcpClient('${hostname}', ${port})
  $ssl = New-Object System.Net.Security.SslStream($c.GetStream(), $false, ({ $true }))
  $ssl.AuthenticateAsClient('${hostname}')
  $leaf = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  $chain.ChainPolicy.VerificationFlags = 'AllFlags'
  [void]$chain.Build($leaf)
  foreach ($el in $chain.ChainElements) {
    $der = $el.Certificate.Export('Cert')
    $b64 = [System.Convert]::ToBase64String($der)
    Write-Output '-----BEGIN CERTIFICATE-----'
    for ($i=0; $i -lt $b64.Length; $i+=64) { Write-Output $b64.Substring($i, [Math]::Min(64, $b64.Length-$i)) }
    Write-Output '-----END CERTIFICATE-----'
  }
  $ssl.Close(); $c.Close()
} catch { exit 1 }
`.trim();
  try {
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return extractPemBlocks(out);
  } catch {
    return [];
  }
}

/**
 * Full capture. We prefer whichever method yields the MORE COMPLETE chain:
 * Bun's native `getPeerCertificate()` often resolves only the leaf when the
 * issuing CA is untrusted (private/enterprise CA). `openssl s_client -showcerts`
 * (macOS/Linux) returns every cert the server presents; on Windows, where
 * openssl is usually absent, PowerShell's X509Chain builds the full chain from
 * the Windows cert store. A single leaf is NOT a usable CA bundle, so a
 * multi-cert chain is preferred over a lone leaf.
 */
export async function captureCertBundle(
  hostname: string,
  port: number,
): Promise<{
  pem: string;
  method: "native" | "openssl" | "powershell" | "none";
  count: number;
}> {
  const native = await captureChainNative(hostname, port);
  const openssl = await captureChainOpenssl(hostname, port);
  const powershell = await captureChainPowershell(hostname, port);
  // Pick the most complete chain. openssl/powershell reflect the real chain;
  // prefer them over a lone native leaf. Between the two, take whichever has more.
  const candidates: Array<{ pems: string[]; method: "native" | "openssl" | "powershell" }> = [
    { pems: openssl, method: "openssl" },
    { pems: powershell, method: "powershell" },
    { pems: native, method: "native" },
  ];
  candidates.sort((a, b) => b.pems.length - a.pems.length);
  const best = candidates[0];
  if (best && best.pems.length > 0) {
    return { pem: best.pems.join(""), method: best.method, count: best.pems.length };
  }
  return { pem: "", method: "none", count: 0 };
}
