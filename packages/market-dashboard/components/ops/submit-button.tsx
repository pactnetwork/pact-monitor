"use client";

import { Button } from "@/components/ui/button";
import { useAuthorityState } from "./authority-gate";

interface Props {
  busy: boolean;
  disabled?: boolean;
  /**
   * If true, the button is gated on the protocol authority match. Set to
   * false for `/ops/topup` (per-pool authority) — that page uses its own
   * `<PoolAuthorityCheck/>` to gate itself.
   */
  requiresProtocolAuthority?: boolean;
  label: string;
  busyLabel?: string;
  onClick: () => void;
}

/**
 * Tri-state submit (idle / pending / ready) per Stripe / GitHub form UX. The
 * button is:
 *   - DISABLED while protocol-authority preflight is loading (no flash of
 *     enabled-then-disabled — see C4 research findings)
 *   - DISABLED on mismatch
 *   - DISABLED while busy
 *   - ENABLED only when authority preflight matches AND not busy
 *
 * On RPC failure of the preflight the button is also disabled but the
 * AuthorityGate's "Retry preflight" CTA is the recovery path.
 */
export function OpsSubmitButton({
  busy,
  disabled,
  requiresProtocolAuthority = true,
  label,
  busyLabel,
  onClick,
}: Props) {
  const auth = useAuthorityState();
  const authorityBlocks =
    requiresProtocolAuthority &&
    (auth.phase === "idle" ||
      auth.phase === "loading" ||
      auth.phase === "mismatch" ||
      auth.phase === "error");
  const isDisabled = busy || Boolean(disabled) || authorityBlocks;

  return (
    <Button
      variant={busy ? "ghost" : "copper"}
      size="md"
      onClick={onClick}
      disabled={isDisabled}
    >
      {busy ? busyLabel ?? "Submitting…" : label}
    </Button>
  );
}
