/**
 * Global cap on concurrent Muse invocations so parallel sessions cannot
 * exhaust the VPS. FIFO queue; waits never count against run timeouts.
 */
export function getMaxConcurrentMuse(): number {
  const raw = process.env.GHOST_MAX_CONCURRENT_MUSE || "2";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(8, Math.floor(n));
}

class MuseLimiter {
  private running = 0;
  private waiters: Array<() => void> = [];

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const cap = getMaxConcurrentMuse();
    if (this.running >= cap) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  /** For tests only. */
  _reset(): void {
    this.running = 0;
    this.waiters = [];
  }
}

export const museLimiter = new MuseLimiter();
