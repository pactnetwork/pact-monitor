import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { formatEther } from 'viem';
import { PipelineService } from '../pipeline/pipeline.service';
import {
  CRIT_THRESHOLD_WEI,
  SignerBalanceService,
  UNKNOWN_BALANCE,
  WARN_THRESHOLD_WEI,
} from './signer-balance.service';

interface MinimalResponse {
  status(code: number): unknown;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  lag_ms: number | null;
  signer: {
    wei: string;
    og: string;
    last_polled_at: number | null;
    last_error: string | null;
    threshold_warn_wei: string;
    threshold_crit_wei: string;
  };
  reason?: string;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly balance: SignerBalanceService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  check(@Res({ passthrough: true }) res: MinimalResponse): HealthResponse {
    const wei = this.balance.currentWei;
    const signer = {
      wei: wei.toString(),
      og: wei === UNKNOWN_BALANCE ? '-1' : formatEther(wei),
      last_polled_at: this.balance.lastPolledAt,
      last_error: this.balance.lastError,
      threshold_warn_wei: WARN_THRESHOLD_WEI.toString(),
      threshold_crit_wei: CRIT_THRESHOLD_WEI.toString(),
    };

    if (wei === UNKNOWN_BALANCE) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'unhealthy',
        lag_ms: this.pipeline.lagMs,
        signer,
        reason: `signer balance not yet known (last_error: ${this.balance.lastError ?? 'none'})`,
      };
    }
    if (wei < CRIT_THRESHOLD_WEI) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'unhealthy',
        lag_ms: this.pipeline.lagMs,
        signer,
        reason: `signer balance ${formatEther(wei)} 0G below CRIT — top up immediately`,
      };
    }
    if (wei < WARN_THRESHOLD_WEI) {
      return {
        status: 'degraded',
        lag_ms: this.pipeline.lagMs,
        signer,
        reason: `signer balance ${formatEther(wei)} 0G below WARN — schedule top-up`,
      };
    }
    return { status: 'ok', lag_ms: this.pipeline.lagMs, signer };
  }
}
