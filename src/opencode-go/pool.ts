/**
 * The OpenCode Go keys this relay holds. Each key is its own Go subscription
 * with its own limits, so the pool only picks which key to try first and moves
 * on when one is refused. It remembers, per model, the key that last worked and
 * starts there next time: no timers and no guessed numbers, and a model keeps
 * using one key (which also keeps Go's prompt caching useful) until that key is
 * refused.
 */
export interface GoKeyStatus {
  label: string;
  last_status: number | null;
  last_at: string | null;
}

export class GoKeyPool {
  private lastGood = new Map<string, number>();
  private seen = new Map<number, { status: number; at: number }>();

  constructor(
    private readonly keys: string[],
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.keys.length;
  }

  key(index: number): string {
    return this.keys[index];
  }

  /** A name safe to show and log: never the key itself. */
  label(index: number): string {
    return `go-key-${index + 1} (...${this.keys[index].slice(-4)})`;
  }

  /** Key indexes to try for `model`, starting with the one that last worked. */
  order(model: string): number[] {
    const n = this.keys.length;
    const start = this.lastGood.get(model) ?? 0;
    return Array.from({ length: n }, (_, k) => (start + k) % n);
  }

  markGood(model: string, index: number): void {
    this.lastGood.set(model, index);
  }

  note(index: number, status: number): void {
    this.seen.set(index, { status, at: this.now() });
  }

  describe(): GoKeyStatus[] {
    return this.keys.map((_, i) => {
      const s = this.seen.get(i);
      return {
        label: this.label(i),
        last_status: s ? s.status : null,
        last_at: s ? new Date(s.at).toISOString() : null,
      };
    });
  }
}
