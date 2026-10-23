/**
 * Fixed-window request counters, in process memory. Enough for this service's single API
 * process; with several API processes behind a balancer each one counts separately, so
 * the effective limit is multiplied (move the counters to Redis then).
 */
export class FixedWindowLimiter {
  #windows = new Map<string, { count: number; resetAt: number }>()
  #sweepAt = 0

  constructor(private now: () => number = Date.now) {}

  /** Counts one hit for `key`; `retryAfterMs` > 0 when it is over `limit` in this window. */
  hit(key: string, limit: number, windowMs: number) {
    const t = this.now()
    this.#sweep(t)
    let w = this.#windows.get(key)
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs }
      this.#windows.set(key, w)
    }
    w.count++
    return { allowed: w.count <= limit, retryAfterMs: w.count <= limit ? 0 : w.resetAt - t }
  }

  /** Forget expired windows now and then, so the map can't grow without bound. */
  #sweep(t: number) {
    if (t < this.#sweepAt) return
    this.#sweepAt = t + 60_000
    for (const [key, w] of this.#windows) if (w.resetAt <= t) this.#windows.delete(key)
  }
}
