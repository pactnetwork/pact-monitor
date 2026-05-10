import type { Envelope } from "./envelope.ts";

export type OutputMode = "json" | "tty" | "quiet";

export interface RenderResult {
  stdout: string;
  stderr: string;
}

export function detectMode(opts: {
  jsonFlag: boolean;
  quietFlag: boolean;
  isTTY: boolean;
}): OutputMode {
  if (opts.jsonFlag) return "json";
  if (opts.quietFlag) return "quiet";
  return opts.isTTY ? "tty" : "json";
}

function renderBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body === undefined || body === null) return "";
  return JSON.stringify(body);
}

export function renderEnvelope(opts: { mode: OutputMode; envelope: Envelope }): RenderResult {
  const e = opts.envelope;
  if (opts.mode === "json") {
    return { stdout: JSON.stringify(e), stderr: "" };
  }
  if (opts.mode === "quiet") {
    return { stdout: renderBody(e.body), stderr: "" };
  }
  // tty mode
  const stdout = renderBody(e.body);
  const meta = e.meta ?? {};
  const parts: string[] = [];
  if (e.status !== "ok") parts.push(e.status);
  if (meta.slug) parts.push(String(meta.slug));
  if (meta.latency_ms !== undefined) parts.push(`${meta.latency_ms}ms`);
  if (meta.premium_usdc !== undefined) parts.push(`${meta.premium_usdc} USDC`);
  const stderr = parts.length > 0 ? parts.join(" · ") : "";
  return { stdout, stderr };
}
