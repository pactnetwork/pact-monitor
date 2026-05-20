"use client";

import { useRef, useState } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  getCoveragePoolPda,
  getEndpointConfigPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { getOperator } from "@/lib/ops/operator";
import { submitOps } from "@/lib/ops/submit";
import { OpsSubmitButton } from "./submit-button";
import { OpsResultBanner, type OpsResult } from "./result-banner";
import {
  validateSlug,
  validateBigIntNonNeg,
  validatePercentBps,
} from "@/lib/ops/validators";

const TOKEN_ACCOUNT_LEN = 165;

export function RegisterForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [slug, setSlug] = useState("");
  const [flatPremium, setFlatPremium] = useState("1000");
  const [percentBps, setPercentBps] = useState("0");
  const [slaMs, setSlaMs] = useState("2000");
  const [imputedCost, setImputedCost] = useState("10000");
  const [exposureCap, setExposureCap] = useState("1000000");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpsResult | null>(null);
  const [vaultBump, setVaultBump] = useState(0);

  // useRef + lazy init survives React Strict Mode (caught in C4 research:
  // useMemo factories are double-invoked in dev; useRef is not). The keypair
  // is regenerated on click via setVaultBump → state change → effect-less
  // ref reset below.
  const vaultRef = useRef<Keypair | null>(null);
  if (vaultRef.current == null) vaultRef.current = Keypair.generate();
  // Reset path: if vaultBump changes (Regenerate clicked) AND the current
  // refkey doesn't match, re-roll. We track the "version" via state.
  // Simpler: regenerate inline in the handler.
  function regenerateVault() {
    vaultRef.current = Keypair.generate();
    setVaultBump((b) => b + 1);
  }
  const vaultPubkey = vaultRef.current.publicKey;

  async function onSubmit() {
    if (!wallet.publicKey) return;
    setResult(null);
    const slugV = validateSlug(slug);
    const flatV = validateBigIntNonNeg(flatPremium, "flatPremiumLamports");
    const pctV = validatePercentBps(percentBps);
    const slaV = validateBigIntNonNeg(slaMs, "slaLatencyMs");
    const impV = validateBigIntNonNeg(imputedCost, "imputedCostLamports");
    const expV = validateBigIntNonNeg(exposureCap, "exposureCapPerHourLamports");
    for (const v of [slugV, flatV, pctV, slaV, impV, expV] as const) {
      if (!v.ok) {
        setResult({ ok: false, error: v.error });
        return;
      }
    }
    if (!slugV.ok || !flatV.ok || !pctV.ok || !slaV.ok || !impV.ok || !expV.ok)
      return;
    setBusy(true);
    try {
      const operator = getOperator(connection);
      const rent = await connection.getMinimumBalanceForRentExemption(
        TOKEN_ACCOUNT_LEN,
      );
      const built = operator.build.register(
        wallet.publicKey,
        {
          slug: slugV.value,
          flatPremiumLamports: flatV.value,
          percentBps: pctV.value,
          slaLatencyMs: Number(slaV.value),
          imputedCostLamports: impV.value,
          exposureCapPerHourLamports: expV.value,
          poolVault: vaultPubkey,
        },
        rent,
      );
      const sub = await submitOps({
        connection,
        wallet,
        instructions: built.instructions,
        priorityFeeAccounts: built.writableAccounts,
        extraSigners: [vaultRef.current!],
      });
      if (!sub.ok) {
        setResult({ ok: false, error: sub.error });
        return;
      }
      const slugBytesBuf = slugBytes(slugV.value);
      const [endpointConfigPda] = getEndpointConfigPda(
        operator.config.programId,
        slugBytesBuf,
      );
      const [coveragePoolPda] = getCoveragePoolPda(
        operator.config.programId,
        slugBytesBuf,
      );
      setResult({
        ok: true,
        signature: sub.signature,
        details: {
          slug: slugV.value,
          "EndpointConfig PDA": endpointConfigPda.toBase58(),
          "CoveragePool PDA": coveragePoolPda.toBase58(),
          "Pool Vault (record this)": vaultPubkey.toBase58(),
        },
        ctas: [
          { label: "Configure this endpoint", href: "/ops/endpoint-config" },
          { label: "Top up pool", href: "/ops/topup" },
          { label: "Set fee recipients", href: "/ops/recipients" },
        ],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">
          Register endpoint
        </h1>
        <p className="text-sm text-[#8a7a70]">
          Creates EndpointConfig + CoveragePool + a new SPL Token pool vault.
          The pool vault keypair is throwaway after this tx — only its pubkey
          matters.
        </p>
      </div>

      <Field label="Slug">
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="acme-api"
          className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Flat premium (USDC base units)">
          <input
            value={flatPremium}
            onChange={(e) => setFlatPremium(e.target.value)}
            className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
          />
        </Field>
        <Field label="Percent bps (0..10000)">
          <input
            value={percentBps}
            onChange={(e) => setPercentBps(e.target.value)}
            className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
          />
        </Field>
        <Field label="SLA latency (ms)">
          <input
            value={slaMs}
            onChange={(e) => setSlaMs(e.target.value)}
            className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
          />
        </Field>
        <Field label="Imputed cost (USDC base units)">
          <input
            value={imputedCost}
            onChange={(e) => setImputedCost(e.target.value)}
            className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
          />
        </Field>
        <Field label="Exposure cap / hour (USDC base units)">
          <input
            value={exposureCap}
            onChange={(e) => setExposureCap(e.target.value)}
            className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
          />
        </Field>
      </div>

      <Field label="Pool vault (auto-generated; throwaway)">
        <div className="flex items-center gap-2">
          <div
            key={vaultBump}
            className="flex-1 bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-xs text-[#f5f0eb] break-all"
          >
            {vaultPubkey.toBase58()}
          </div>
          <button
            type="button"
            onClick={regenerateVault}
            disabled={busy}
            className="px-3 py-2 border border-[#2a2420] text-xs hover:bg-[#2a2420] disabled:opacity-50"
          >
            Regenerate
          </button>
        </div>
      </Field>

      <div className="flex items-center gap-3">
        <OpsSubmitButton
          busy={busy}
          label="Register"
          busyLabel="Registering…"
          onClick={onSubmit}
        />
      </div>

      <OpsResultBanner result={result} />
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <div className="text-xs font-mono text-[#8a7a70] uppercase tracking-wide">
        {label}
      </div>
      {children}
    </label>
  );
}

// Suppress unused-warning when the inner PublicKey import isn't directly used.
export type _RegisterFormPubkey = PublicKey;
