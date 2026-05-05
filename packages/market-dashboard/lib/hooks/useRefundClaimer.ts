"use client";

import { useState, useEffect, useRef } from "react";

interface UseRefundClaimerOptions {
  pubkey: string | null;
  pendingRefund: number;
  onClaim: () => Promise<void>;
}

interface UseRefundClaimerResult {
  claiming: boolean;
  lastClaimError: string | null;
}

// Auto-claims when pendingRefund > 0 for 2 consecutive observations.
// The 2-poll debounce guards against acting on a tx that is already in-flight.
export function useRefundClaimer({
  pubkey,
  pendingRefund,
  onClaim,
}: UseRefundClaimerOptions): UseRefundClaimerResult {
  const [claiming, setClaiming] = useState(false);
  const [lastClaimError, setLastClaimError] = useState<string | null>(null);
  // Count of consecutive polls where pendingRefund > 0
  const consecutiveRef = useRef(0);
  const claimingRef = useRef(false);

  useEffect(() => {
    if (!pubkey) {
      consecutiveRef.current = 0;
      return;
    }

    if (pendingRefund > 0) {
      consecutiveRef.current += 1;
    } else {
      consecutiveRef.current = 0;
      return;
    }

    if (consecutiveRef.current >= 2 && !claimingRef.current) {
      consecutiveRef.current = 0;
      claimingRef.current = true;
      setClaiming(true);
      setLastClaimError(null);
      onClaim()
        .catch((e) => setLastClaimError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          claimingRef.current = false;
          setClaiming(false);
        });
    }
  }, [pubkey, pendingRefund, onClaim]);

  return { claiming, lastClaimError };
}
