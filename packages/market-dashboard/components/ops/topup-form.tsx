"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  decodeCoveragePool,
  getCoveragePoolPda,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { getOperator, PROGRAM, MINT } from "@/lib/ops/operator";
import { submitOps } from "@/lib/ops/submit";
import { OpsSubmitButton } from "./submit-button";
import { OpsResultBanner, type OpsResult } from "./result-banner";
import { validateSlug, validateUsdcDecimal } from "@/lib/ops/validators";

type PoolCheck =
  | { phase: "idle" }
  | { phase: "loading" }
  | {
      phase: "match";
      coveragePool: PublicKey;
      poolVault: PublicKey;
      onChainAuthority: PublicKey;
    }
  | {
      phase: "mismatch";
      coveragePool: PublicKey;
      expected: PublicKey;
      connected: PublicKey;
    }
  | { phase: "missing"; coveragePool: PublicKey }
  | { phase: "error"; error: string };

export function TopupForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [slug, setSlug] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpsResult | null>(null);
  const [poolCheck, setPoolCheck] = useState<PoolCheck>({ phase: "idle" });

  // Debounce-on-blur preflight: when slug + wallet are both present, derive
  // the CoveragePool PDA, decode it, compare authority to wallet.
  useEffect(() => {
    if (!wallet.publicKey) {
      setPoolCheck({ phase: "idle" });
      return;
    }
    const slugV = validateSlug(slug);
    if (!slugV.ok) {
      setPoolCheck({ phase: "idle" });
      return;
    }
    let cancelled = false;
    setPoolCheck({ phase: "loading" });
    const slugBytesBuf = slugBytes(slugV.value);
    const [coveragePool] = getCoveragePoolPda(PROGRAM, slugBytesBuf);
    (async () => {
      try {
        const info = await connection.getAccountInfo(coveragePool, "confirmed");
        if (cancelled) return;
        if (!info) {
          setPoolCheck({ phase: "missing", coveragePool });
          return;
        }
        const pool = decodeCoveragePool(info.data);
        const onChainAuthority = new PublicKey(pool.authority as never);
        const poolVault = new PublicKey(pool.usdcVault as never);
        if (onChainAuthority.equals(wallet.publicKey!)) {
          setPoolCheck({
            phase: "match",
            coveragePool,
            poolVault,
            onChainAuthority,
          });
        } else {
          setPoolCheck({
            phase: "mismatch",
            coveragePool,
            expected: onChainAuthority,
            connected: wallet.publicKey!,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setPoolCheck({
          phase: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, wallet.publicKey, slug]);

  async function onSubmit() {
    if (!wallet.publicKey) return;
    if (poolCheck.phase !== "match") return;
    setResult(null);
    const amountV = validateUsdcDecimal(amount);
    if (!amountV.ok) {
      setResult({ ok: false, error: amountV.error });
      return;
    }
    setBusy(true);
    try {
      const operator = getOperator(connection);
      const authorityAta = deriveAta(MINT, wallet.publicKey);
      const built = operator.build.topUpCoveragePool(wallet.publicKey, {
        slug,
        amount: amountV.value,
        authorityAta,
        poolVault: poolCheck.poolVault,
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
            slug,
            amount: amount + " USDC",
            "CoveragePool PDA": poolCheck.coveragePool.toBase58(),
          },
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
          Top up coverage pool
        </h1>
        <p className="text-sm text-[#8a7a70]">
          Per-pool authority (NOT ProtocolConfig.authority). The connected
          wallet must be CoveragePool.authority for the target slug.
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

      <PoolAuthorityCheckBanner state={poolCheck} />

      <label className="block space-y-1">
        <div className="text-xs font-mono text-[#8a7a70] uppercase tracking-wide">
          Amount (USDC, decimal)
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="5"
          className="w-full bg-[#1f1a17] border border-[#2a2420] px-3 py-2 font-mono text-[#f5f0eb]"
        />
      </label>

      <OpsSubmitButton
        busy={busy}
        disabled={poolCheck.phase !== "match"}
        requiresProtocolAuthority={false}
        label="Top up"
        onClick={onSubmit}
      />

      <OpsResultBanner result={result} />
    </div>
  );
}

function PoolAuthorityCheckBanner({ state }: { state: PoolCheck }) {
  if (state.phase === "idle") return null;
  if (state.phase === "loading") {
    return (
      <div className="border border-[#2a2420] p-3 text-xs font-mono text-[#8a7a70]">
        Resolving CoveragePool authority…
      </div>
    );
  }
  if (state.phase === "match") {
    return (
      <div className="border border-[#5A6B7A] p-3 text-xs font-mono text-[#5A6B7A]">
        Pool authority OK
      </div>
    );
  }
  if (state.phase === "missing") {
    return (
      <div className="border border-[#C9553D] p-3 text-xs font-mono text-[#f5f0eb]">
        CoveragePool not found at {state.coveragePool.toBase58()} — register
        this slug first.
      </div>
    );
  }
  if (state.phase === "mismatch") {
    return (
      <div className="border-2 border-[#C9553D] p-3 text-xs font-mono text-[#f5f0eb] bg-[#2a1a18]">
        <div className="font-bold text-[#C9553D] mb-1">
          Connected wallet is not CoveragePool.authority for this slug
        </div>
        <div className="text-[#8a7a70]">Expected:</div>
        <div className="break-all">{state.expected.toBase58()}</div>
        <div className="text-[#8a7a70] mt-1">Connected:</div>
        <div className="break-all">{state.connected.toBase58()}</div>
      </div>
    );
  }
  // error
  return (
    <div className="border border-[#C9553D] p-3 text-xs font-mono text-[#f5f0eb]">
      <div className="font-bold text-[#C9553D]">RPC error</div>
      <div>{state.error}</div>
    </div>
  );
}

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ATA_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
function deriveAta(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}
