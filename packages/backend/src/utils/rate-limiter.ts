export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  warning: boolean;
  resetAt: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly WARNING_THRESHOLD = 0.8;

  constructor(opts: { maxPerWindow: number; windowMs: number }) {
    this.maxPerWindow = opts.maxPerWindow;
    this.windowMs = opts.windowMs;
  }

  check(key: string): RateLimitResult {
    return this.increment(key, 1);
  }

  increment(key: string, count: number): RateLimitResult {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }

    const wouldExceed = entry.count + count > this.maxPerWindow;
    if (wouldExceed) {
      return {
        allowed: false,
        remaining: Math.max(0, this.maxPerWindow - entry.count),
        warning: true,
        resetAt: entry.resetAt,
      };
    }

    entry.count += count;
    const remaining = this.maxPerWindow - entry.count;
    const warning = entry.count >= this.maxPerWindow * this.WARNING_THRESHOLD;

    return { allowed: true, remaining, warning, resetAt: entry.resetAt };
  }

  /** Test helper: expire a key's window */
  _expireKey(key: string): void {
    this.entries.delete(key);
  }
}
