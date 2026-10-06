export class LoginRateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, maxAttempts = 8, maxEntries = 4096 } = {}) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
    this.maxEntries = maxEntries;
    this.buckets = new Map();
  }

  check(key, now = Date.now()) {
    this.cleanup(now);
    if (!this.buckets.has(key) && this.buckets.size >= this.maxEntries) {
      this.evictOldest();
      if (this.buckets.size >= this.maxEntries) {
        return { allowed: false, statusCode: 429 };
      }
    }

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      this.buckets.set(key, { count: 1, reset: now + this.windowMs });
      return { allowed: true };
    }
    bucket.count += 1;
    return { allowed: bucket.count <= this.maxAttempts, statusCode: 429 };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  cleanup(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.reset <= now) this.buckets.delete(key);
    }
  }

  evictOldest() {
    let oldestKey = null;
    let oldestReset = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.reset < oldestReset) {
        oldestKey = key;
        oldestReset = bucket.reset;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}
