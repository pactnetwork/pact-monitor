"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getOperator } from "@/lib/ops/operator";
import { submitOps } from "@/lib/ops/submit";
import { OpsSubmitButton } from "./submit-button";
import { OpsResultBanner, type OpsResult } from "./result-banner";
import { validateSlug } from "@/lib/ops/validators";

export function PauseEndpointForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [slug, setSlug] = useState("");
  const [paused, setPaused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpsResult | null>(null);

  async function onSubmit() {
    if (!wallet.publicKey) return;
    setResult(null);
    const slugV = validateSlug(slug);
    if (!slugV.ok) {
      setResult({ ok: false, error: slugV.error });
      return;
    }
    setBusy(true);
    try {
      const operator = getOperator(connection);
      const built = operator.build.pauseEndpoint(wallet.publicKey, {
        slug: slugV.value,
        paused,
      });
      const sub = await submitOps({
        connection,
        wallet,
        instructions: built.instructions,
        priorityFeeAccounts: built.writableAccounts,
      });
      if (!sub.ok) {
        setResult({ ok: false, error: sub.error });
      } else {
        setResult({
          ok: true,
          signature: sub.signature,
          details: { slug: slugV.value, paused: String(paused) },
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">
          Pause endpoint
        </h1>
        <p className="text-sm text-[#8a7a70]">
          Per-endpoint pause toggle. Different from{" "}
          <code className="text-[#B87333]">pact pause</code> (global protocol kill switch).
        </p>
      </div>

      <label className="block space-y-1">
        <div className="text-xs font-mono text-[#8a7a70] uppercase tracking-wide">
          Slug
        </div>
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="acme-api"
          className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
        />
      </label>

      <label className="flex items-center gap-2 font-mono text-sm text-[#f5f0eb]">
        <input
          type="checkbox"
          checked={paused}
          onChange={(e) => setPaused(e.target.checked)}
        />
        Set paused = {paused ? "true" : "false"}
      </label>

      <OpsSubmitButton
        busy={busy}
        label={paused ? "Pause endpoint" : "Unpause endpoint"}
        onClick={onSubmit}
      />

      <OpsResultBanner result={result} />
    </div>
  );
}
