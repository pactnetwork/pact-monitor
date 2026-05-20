"use client";

import { explorerTxUrl } from "@/lib/ops/submit";

export interface OpsResultSuccess {
  ok: true;
  signature: string;
  /** Map of label → pubkey base58 to render in the result card. */
  details?: Record<string, string>;
  /** Optional CTA block (e.g., "Configure this endpoint" link). */
  ctas?: { label: string; href: string }[];
}

export interface OpsResultError {
  ok: false;
  error: string;
}

export type OpsResult = OpsResultSuccess | OpsResultError;

export function OpsResultBanner({ result }: { result: OpsResult | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <div className="border border-[#C9553D] p-4 text-sm font-mono text-[#f5f0eb] bg-[#2a1a18]">
        <div className="font-bold text-[#C9553D] mb-1">Submit failed</div>
        <div className="text-xs break-all">{result.error}</div>
      </div>
    );
  }
  return (
    <div className="border border-[#5A6B7A] p-4 text-sm font-mono text-[#f5f0eb]">
      <div className="font-bold text-[#5A6B7A] mb-2">Submitted</div>
      <div className="space-y-1">
        <div>
          <span className="text-xs text-[#8a7a70]">Signature:&nbsp;</span>
          <a
            href={explorerTxUrl(result.signature)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#B87333] underline break-all"
          >
            {result.signature}
          </a>
        </div>
        {result.details &&
          Object.entries(result.details).map(([k, v]) => (
            <div key={k}>
              <span className="text-xs text-[#8a7a70]">{k}:&nbsp;</span>
              <span className="break-all">{v}</span>
            </div>
          ))}
      </div>
      {result.ctas && result.ctas.length > 0 && (
        <div className="mt-3 flex gap-2 flex-wrap">
          {result.ctas.map((cta) => (
            <a
              key={cta.href}
              href={cta.href}
              className="px-3 py-1 border border-[#2a2420] hover:bg-[#2a2420] text-xs"
            >
              {cta.label} →
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
