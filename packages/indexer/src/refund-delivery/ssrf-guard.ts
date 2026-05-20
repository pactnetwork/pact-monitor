/**
 * SSRF defense for outbound webhook delivery. The agent supplies `webhookUrl`
 * and the indexer makes an outbound request to it — a classic SSRF surface.
 *
 * Two layers:
 *  1. `assertSafeWebhookUrl` — cheap upfront reject (https-only, no userinfo,
 *     port allowlist). Run at registration AND before every delivery.
 *  2. `safeDispatcher()` — an undici Agent whose custom `connect.lookup`
 *     re-resolves the hostname per connection and refuses to connect to any
 *     private / loopback / link-local / ULA / metadata / CGNAT address. This
 *     is the TOCTOU-safe enforcement: the connection is pinned to the
 *     validated IP while the URL keeps the hostname so TLS SNI / certificate
 *     verification stay correct (substituting an IP into the URL would break
 *     cert validation — explicitly NOT done). Redirects are disabled by the
 *     caller (`maxRedirections: 0`).
 */
import { lookup as dnsLookup } from "node:dns";
import { Agent } from "undici";

export class SsrfRejectedError extends Error {
  constructor(reason: string) {
    super(`webhook target rejected: ${reason}`);
    this.name = "SsrfRejectedError";
  }
}

const ALLOWED_PORTS = new Set(["", "443"]);

/** Cheap, synchronous URL-shape gate. Throws SsrfRejectedError. */
export function assertSafeWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfRejectedError("unparseable URL");
  }
  if (u.protocol !== "https:") throw new SsrfRejectedError("must be https");
  if (u.username || u.password)
    throw new SsrfRejectedError("URL must not contain credentials");
  if (!ALLOWED_PORTS.has(u.port))
    throw new SsrfRejectedError(`port ${u.port} not allowed (443 only)`);
  // An IP literal that is obviously unsafe is rejected here too; a hostname
  // is fully validated at connect time by safeDispatcher's lookup.
  if (isUnsafeIp(u.hostname)) throw new SsrfRejectedError("private/loopback IP literal");
  return u;
}

/** True if `ip` is a literal address in a forbidden range. */
export function isUnsafeIp(ip: string): boolean {
  // Strip brackets / zone id from IPv6.
  const h = ip.replace(/^\[|\]$/g, "").split("%")[0];

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> classify the embedded v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (mapped) return isUnsafeIpv4(mapped[1]);

  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isUnsafeIpv4(h);

  if (h.includes(":")) {
    const lo = h.toLowerCase();
    if (lo === "::1" || lo === "::" || lo === "::0") return true; // loopback/unspecified
    if (/^f[cd][0-9a-f]{2}:/.test(lo)) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/.test(lo)) return true; // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(lo)) return true; // ff00::/8 multicast
    return false;
  }
  // Not an IP literal (a hostname) — defer to connect-time lookup.
  return false;
}

function isUnsafeIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true; // malformed -> reject
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;

/**
 * undici dispatcher that resolves the hostname itself and refuses any
 * forbidden address. Pass as `dispatcher` to `fetch`.
 */
export function safeDispatcher(connectTimeoutMs = 5_000): Agent {
  return new Agent({
    connect: {
      timeout: connectTimeoutMs,
      lookup(hostname: string, options: unknown, callback: LookupCb): void {
        dnsLookup(
          hostname,
          { all: true, verbatim: true },
          (err, addresses) => {
            if (err) return callback(err, "", 0);
            if (!addresses.length)
              return callback(
                new Error("no addresses resolved") as NodeJS.ErrnoException,
                "",
                0,
              );
            for (const a of addresses) {
              if (isUnsafeIp(a.address)) {
                return callback(
                  Object.assign(
                    new Error(
                      `SSRF: ${hostname} resolves to forbidden ${a.address}`,
                    ),
                    { code: "ESSRF" },
                  ) as NodeJS.ErrnoException,
                  "",
                  0,
                );
              }
            }
            // Pin to the first validated address (connection goes there; the
            // URL still carries `hostname` so TLS verifies correctly).
            const first = addresses[0];
            callback(null, first.address, first.family);
          },
        );
      },
    },
  });
}
