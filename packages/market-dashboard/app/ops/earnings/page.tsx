"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { validatePubkey } from "@/lib/ops/validators";

export default function EarningsSearch() {
  const router = useRouter();
  const [pubkey, setPubkey] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const v = validatePubkey(pubkey);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    router.push(`/ops/earnings/${encodeURIComponent(v.value.toBase58())}`);
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">
          Affiliate earnings
        </h1>
        <p className="text-sm text-[#8a7a70]">
          Look up lifetime earnings and recent settlements for any fee
          recipient pubkey. Public, no signer required.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block space-y-1">
          <div className="text-xs font-mono text-[#8a7a70] uppercase tracking-wide">
            Recipient pubkey
          </div>
          <input
            value={pubkey}
            onChange={(e) => setPubkey(e.target.value)}
            placeholder="e.g. 5XyG…rW1"
            className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
          />
        </label>
        {error && (
          <div className="text-xs font-mono text-[#C9553D]">{error}</div>
        )}
        <button
          type="submit"
          className="px-4 py-2 bg-[#B87333] text-[#151311] font-mono text-sm hover:bg-[#a06228]"
        >
          Look up
        </button>
      </form>
    </div>
  );
}
