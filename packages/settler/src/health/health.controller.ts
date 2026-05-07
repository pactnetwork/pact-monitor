import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Res,
} from "@nestjs/common";

import { PipelineService } from "../pipeline/pipeline.service";

/**
 * Minimal shape of the express.Response object used here. Inlined so we
 * don't have to add @types/express to the settler package just for one
 * .status() call.
 */
interface MinimalResponse {
  status(code: number): unknown;
}
import {
  CRIT_THRESHOLD_LAMPORTS,
  LAMPORTS_PER_SOL,
  SignerBalanceService,
  UNKNOWN_BALANCE,
  WARN_THRESHOLD_LAMPORTS,
} from "./signer-balance.service";

/**
 * /health response shape. Stable wire format — Cloud Run startup probes,
 * uptime checks, and the LB health check all key off `status` and the HTTP
 * status code (200 vs 503).
 */
export interface HealthResponse {
  /**
   * `ok`        — pipeline + signer healthy.
   * `degraded`  — signer below WARN but above CRIT (200 OK; alerts route).
   * `unhealthy` — signer below CRIT or balance unknown (RPC failure at boot
   *               with no successful poll yet). HTTP 503.
   */
  status: "ok" | "degraded" | "unhealthy";
  lag_ms: number | null;
  signer: {
    lamports: number;
    sol: number;
    last_polled_at: number | null;
    last_error: string | null;
    threshold_warn_lamports: number;
    threshold_crit_lamports: number;
  };
  reason?: string;
}

@Controller("health")
export class HealthController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly balance: SignerBalanceService,
  ) {}

  /**
   * Health endpoint. Returns HTTP 200 for `ok` and `degraded`, HTTP 503 for
   * `unhealthy`. Cloud Run health checks treat any non-2xx as failure and
   * will deroute the instance, so we use 503 only for hard failures (signer
   * truly out of SOL / never successfully polled).
   *
   * Why `degraded` is still 200: we want the alert to page on-call but we
   * don't want to flap the LB / kill in-flight batches when we're still able
   * to settle (~300+ batches of headroom).
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  check(@Res({ passthrough: true }) res: MinimalResponse): HealthResponse {
    const lamports = this.balance.currentLamports;
    const lastPolledAt = this.balance.lastPolledAt;
    const lastError = this.balance.lastError;

    const signer = {
      lamports,
      sol: lamports === UNKNOWN_BALANCE ? -1 : lamports / LAMPORTS_PER_SOL,
      last_polled_at: lastPolledAt,
      last_error: lastError,
      threshold_warn_lamports: WARN_THRESHOLD_LAMPORTS,
      threshold_crit_lamports: CRIT_THRESHOLD_LAMPORTS,
    };

    // Hard fail: never successfully polled (balance unknown). Treat as
    // unhealthy because the pipeline relies on an RPC connection too — if we
    // can't even fetch a balance, we very likely can't submit txs either.
    if (lamports === UNKNOWN_BALANCE) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: "unhealthy",
        lag_ms: this.pipeline.lagMs,
        signer,
        reason: `signer balance not yet known (last_error: ${lastError ?? "none"})`,
      };
    }

    // Hard fail: signer below CRIT floor. /health flips to 503 so the LB
    // deroutes; on-call must top up before traffic resumes.
    if (lamports < CRIT_THRESHOLD_LAMPORTS) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: "unhealthy",
        lag_ms: this.pipeline.lagMs,
        signer,
        reason: `signer balance ${lamports} lamports below CRIT floor ${CRIT_THRESHOLD_LAMPORTS} — top up immediately (see runbooks/settler-signer-low-sol.md)`,
      };
    }

    // Soft fail: WARN. 200 OK so the LB keeps routing, but the alert pages.
    if (lamports < WARN_THRESHOLD_LAMPORTS) {
      return {
        status: "degraded",
        lag_ms: this.pipeline.lagMs,
        signer,
        reason: `signer balance ${lamports} lamports below WARN ${WARN_THRESHOLD_LAMPORTS} — schedule top-up`,
      };
    }

    return {
      status: "ok",
      lag_ms: this.pipeline.lagMs,
      signer,
    };
  }
}
