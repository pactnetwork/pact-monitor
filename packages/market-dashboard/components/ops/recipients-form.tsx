"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  FeeRecipientKind,
  decodeProtocolConfig,
  getProtocolConfigPda,
  type FeeRecipient,
} from "@q3labs/pact-protocol-v1-client";
import { getOperator, PROGRAM } from "@/lib/ops/operator";
import { submitOps } from "@/lib/ops/submit";
import { OpsSubmitButton } from "./submit-button";
import { OpsResultBanner, type OpsResult } from "./result-banner";
import {
  type RecipientRow,
  validateRecipients,
  validateSlug,
} from "@/lib/ops/validators";

const DEFAULT_MAX_TOTAL_FEE_BPS = 3000;

export function RecipientsForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [slug, setSlug] = useState("");
  const [maxBps, setMaxBps] = useState<number>(DEFAULT_MAX_TOTAL_FEE_BPS);
  const [rows, setRows] = useState<RecipientRow[]>([
    { id: rid(), kind: "Treasury", destination: "", bps: "1000" },
  ]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpsResult | null>(null);

  // Read on-chain ProtocolConfig.max_total_fee_bps once. Falls back to the
  // default if the read fails — the program will enforce the real cap on
  // submit anyway, so this is a UX hint, not a security boundary.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pda] = getProtocolConfigPda(PROGRAM);
        const info = await connection.getAccountInfo(pda, "confirmed");
        if (!info || cancelled) return;
        const cfg = decodeProtocolConfig(info.data);
        if (typeof cfg.maxTotalFeeBps === "number") {
          setMaxBps(cfg.maxTotalFeeBps);
        }
      } catch {
        /* keep default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const validation = validateRecipients(rows, maxBps);

  function updateRow(id: string, patch: Partial<RecipientRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }
  function addRow() {
    if (rows.length >= 8) return;
    setRows((rs) => [
      ...rs,
      { id: rid(), kind: "AffiliateAta", destination: "", bps: "0" },
    ]);
  }

  async function onSubmit() {
    if (!wallet.publicKey) return;
    setResult(null);
    const slugV = validateSlug(slug);
    if (!slugV.ok) {
      setResult({ ok: false, error: slugV.error });
      return;
    }
    if (!validation.ok) {
      setResult({
        ok: false,
        error: validation.formErrors.join("; ") ||
          "fix per-row errors before submitting",
      });
      return;
    }
    const feeRecipients: FeeRecipient[] = validation.parsed.map((r) => ({
      kind:
        r.kind === "Treasury"
          ? FeeRecipientKind.Treasury
          : FeeRecipientKind.AffiliateAta,
      destination: r.destination.toBase58(),
      bps: r.bps,
    }));
    const affiliateAtas: PublicKey[] = validation.parsed
      .filter((r) => r.kind === "AffiliateAta")
      .map((r) => r.destination);

    setBusy(true);
    try {
      const operator = getOperator(connection);
      const built = operator.build.updateFeeRecipients(wallet.publicKey, {
        slug: slugV.value,
        feeRecipients,
        affiliateAtas,
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
          details: {
            slug: slugV.value,
            count: String(feeRecipients.length),
            "sum bps": String(validation.sumBps),
          },
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">
          Update fee recipients
        </h1>
        <p className="text-sm text-[#8a7a70]">
          Replaces the EndpointConfig.fee_recipients array. Sum ≤{" "}
          {maxBps} bps (ProtocolConfig.max_total_fee_bps). Exactly one
          Treasury entry with bps &gt; 0 required.
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

      <div className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="grid grid-cols-[120px_1fr_100px_auto] gap-2 items-start"
          >
            <select
              value={r.kind}
              onChange={(e) =>
                updateRow(r.id, {
                  kind: e.target.value as RecipientRow["kind"],
                })
              }
              className="bg-[#1f1a17] border border-[#2a2420] px-2 py-2 font-mono text-[#f5f0eb]"
            >
              <option value="Treasury">Treasury</option>
              <option value="AffiliateAta">AffiliateAta</option>
            </select>
            <div>
              <input
                value={r.destination}
                onChange={(e) =>
                  updateRow(r.id, { destination: e.target.value })
                }
                placeholder="destination pubkey (base58)"
                className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
              />
              {validation.rowErrors[r.id] && (
                <div className="text-xs text-[#C9553D] mt-1">
                  {validation.rowErrors[r.id]}
                </div>
              )}
            </div>
            <input
              value={r.bps}
              onChange={(e) => updateRow(r.id, { bps: e.target.value })}
              placeholder="bps"
              className="bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
            />
            <button
              type="button"
              onClick={() => removeRow(r.id)}
              className="px-3 py-2 border border-[#2a2420] text-xs hover:bg-[#2a2420]"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          disabled={rows.length >= 8}
          className="px-3 py-2 border border-[#2a2420] text-xs hover:bg-[#2a2420] disabled:opacity-50"
        >
          + Add recipient
        </button>
      </div>

      <div className="border border-[#2a2420] p-3 font-mono text-sm">
        <span className="text-[#8a7a70]">Sum bps: </span>
        <span
          className={
            validation.sumBps > maxBps ? "text-[#C9553D]" : "text-[#5A6B7A]"
          }
        >
          {validation.sumBps}
        </span>
        <span className="text-[#8a7a70]"> / {maxBps}</span>
        {validation.formErrors.length > 0 && (
          <ul className="mt-2 text-xs text-[#C9553D] space-y-0.5">
            {validation.formErrors.map((e) => (
              <li key={e}>· {e}</li>
            ))}
          </ul>
        )}
      </div>

      <OpsSubmitButton
        busy={busy}
        disabled={!validation.ok}
        label="Update fee recipients"
        onClick={onSubmit}
      />

      <OpsResultBanner result={result} />
    </div>
  );
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
