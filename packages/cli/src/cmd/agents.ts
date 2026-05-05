import type { Envelope } from "../lib/envelope.ts";
import { loadOrCreateWallet } from "../lib/wallet.ts";

export async function agentsShowCommand(opts: {
  configDir: string;
  gatewayUrl: string;
  pubkey?: string;
  callId?: string;
}): Promise<Envelope> {
  let pubkey = opts.pubkey;
  if (!pubkey) {
    pubkey = loadOrCreateWallet({ configDir: opts.configDir }).keypair.publicKey.toBase58();
  }
  const path = opts.callId
    ? `/v1/agents/${pubkey}/calls/${opts.callId}`
    : `/v1/agents/${pubkey}`;
  const url = `${opts.gatewayUrl.replace(/\/$/, "")}${path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    return {
      status: "cli_internal_error",
      body: { http_status: resp.status, url },
    };
  }
  const body = await resp.json();
  return { status: "ok", body };
}

export async function agentsWatchCommand(opts: {
  configDir: string;
  gatewayUrl: string;
  pubkey?: string;
  onEvent: (event: unknown) => void;
}): Promise<void> {
  let pubkey = opts.pubkey;
  if (!pubkey) {
    pubkey = loadOrCreateWallet({ configDir: opts.configDir }).keypair.publicKey.toBase58();
  }
  const url = `${opts.gatewayUrl.replace(/\/$/, "")}/v1/agents/${pubkey}/events`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`watch: HTTP ${resp.status}`);
  }
  if (!resp.body) throw new Error("watch: no response body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const data = chunk.replace(/^data: /, "");
      try {
        opts.onEvent(JSON.parse(data));
      } catch {
        opts.onEvent(data);
      }
    }
  }
}
