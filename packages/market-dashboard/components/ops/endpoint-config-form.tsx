"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getOperator } from "@/lib/ops/operator";
import { submitOps } from "@/lib/ops/submit";
import { OpsSubmitButton } from "./submit-button";
import { OpsResultBanner, type OpsResult } from "./result-banner";
import {
  validateBigIntNonNeg,
  validatePercentBps,
  validateSlug,
} from "@/lib/ops/validators";

interface FieldState {
  enabled: boolean;
  value: string;
}

export function EndpointConfigForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [slug, setSlug] = useState("");
  const [flatPremium, setFlatPremium] = useState<FieldState>({
    enabled: false,
    value: "",
  });
  const [percentBps, setPercentBps] = useState<FieldState>({
    enabled: false,
    value: "",
  });
  const [slaMs, setSlaMs] = useState<FieldState>({ enabled: false, value: "" });
  const [imputedCost, setImputedCost] = useState<FieldState>({
    enabled: false,
    value: "",
  });
  const [exposureCap, setExposureCap] = useState<FieldState>({
    enabled: false,
    value: "",
  });
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
    const enabled = [
      flatPremium.enabled,
      percentBps.enabled,
      slaMs.enabled,
      imputedCost.enabled,
      exposureCap.enabled,
    ];
    if (!enabled.some(Boolean)) {
      setResult({
        ok: false,
        error: "no_fields: tick at least one field to update",
      });
      return;
    }
    const params: Parameters<
      ReturnType<typeof getOperator>["build"]["updateEndpointConfig"]
    >[1] = { slug: slugV.value };
    if (flatPremium.enabled) {
      const v = validateBigIntNonNeg(flatPremium.value, "flatPremiumLamports");
      if (!v.ok) {
        setResult({ ok: false, error: v.error });
        return;
      }
      params.flatPremiumLamports = v.value;
    }
    if (percentBps.enabled) {
      const v = validatePercentBps(percentBps.value);
      if (!v.ok) {
        setResult({ ok: false, error: v.error });
        return;
      }
      params.percentBps = v.value;
    }
    if (slaMs.enabled) {
      const v = validateBigIntNonNeg(slaMs.value, "slaLatencyMs");
      if (!v.ok) {
        setResult({ ok: false, error: v.error });
        return;
      }
      params.slaLatencyMs = Number(v.value);
    }
    if (imputedCost.enabled) {
      const v = validateBigIntNonNeg(imputedCost.value, "imputedCostLamports");
      if (!v.ok) {
        setResult({ ok: false, error: v.error });
        return;
      }
      params.imputedCostLamports = v.value;
    }
    if (exposureCap.enabled) {
      const v = validateBigIntNonNeg(
        exposureCap.value,
        "exposureCapPerHourLamports",
      );
      if (!v.ok) {
        setResult({ ok: false, error: v.error });
        return;
      }
      params.exposureCapPerHourLamports = v.value;
    }
    setBusy(true);
    try {
      const operator = getOperator(connection);
      const built = operator.build.updateEndpointConfig(
        wallet.publicKey,
        params,
      );
      const sub = await submitOps({
        connection,
        wallet,
        instructions: built.instructions,
        priorityFeeAccounts: built.writableAccounts,
      });
      if (!sub.ok) {
        setResult({ ok: false, error: sub.error });
      } else {
        const updatedFields: string[] = [];
        if (flatPremium.enabled) updatedFields.push("flat_premium_lamports");
        if (percentBps.enabled) updatedFields.push("percent_bps");
        if (slaMs.enabled) updatedFields.push("sla_latency_ms");
        if (imputedCost.enabled) updatedFields.push("imputed_cost_lamports");
        if (exposureCap.enabled)
          updatedFields.push("exposure_cap_per_hour_lamports");
        setResult({
          ok: true,
          signature: sub.signature,
          details: {
            slug: slugV.value,
            updated: updatedFields.join(", "),
          },
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">
          Update endpoint config
        </h1>
        <p className="text-sm text-[#8a7a70]">
          Partial update — tick fields to include them in the tx. At least one
          field required.
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

      <div className="space-y-3">
        <FieldRow
          label="Flat premium (USDC base units)"
          state={flatPremium}
          setState={setFlatPremium}
        />
        <FieldRow
          label="Percent bps (0..10000)"
          state={percentBps}
          setState={setPercentBps}
        />
        <FieldRow label="SLA latency (ms)" state={slaMs} setState={setSlaMs} />
        <FieldRow
          label="Imputed cost (USDC base units)"
          state={imputedCost}
          setState={setImputedCost}
        />
        <FieldRow
          label="Exposure cap / hour (USDC base units)"
          state={exposureCap}
          setState={setExposureCap}
        />
      </div>

      <OpsSubmitButton
        busy={busy}
        label="Update config"
        onClick={onSubmit}
      />

      <OpsResultBanner result={result} />
    </div>
  );
}

function FieldRow({
  label,
  state,
  setState,
}: {
  label: string;
  state: FieldState;
  setState: (s: FieldState) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="checkbox"
        checked={state.enabled}
        onChange={(e) => setState({ ...state, enabled: e.target.checked })}
      />
      <div className="flex-1">
        <div className="text-xs font-mono text-[#8a7a70] uppercase tracking-wide">
          {label}
        </div>
        <input
          value={state.value}
          onChange={(e) => setState({ ...state, value: e.target.value })}
          disabled={!state.enabled}
          placeholder={state.enabled ? "" : "leave unchanged"}
          className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb] disabled:opacity-50"
        />
      </div>
    </div>
  );
}
