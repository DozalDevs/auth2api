import crypto from "crypto";

export const SETUP_CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_LIVE_CODES_PER_KEY = 5;

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

/**
 * One-time codes that let a setup script fetch its own key, so a person never
 * has to copy and paste it. Kept in memory only: a restart voids them, which
 * is fine for something that lives fifteen minutes. Only a hash of each code
 * is held.
 */
export class SetupCodeStore {
  private codes = new Map<string, { key: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const at = this.now();
    for (const [h, c] of this.codes)
      if (c.expiresAt <= at) this.codes.delete(h);
  }

  mint(keyName: string): { code: string; expiresAt: string } {
    this.prune();
    const mine = [...this.codes.entries()]
      .filter(([, c]) => c.key.toLowerCase() === keyName.toLowerCase())
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    while (mine.length >= MAX_LIVE_CODES_PER_KEY) {
      this.codes.delete(mine.shift()![0]);
    }
    const code = crypto.randomBytes(24).toString("base64url");
    const expiresAt = this.now() + SETUP_CODE_TTL_MS;
    this.codes.set(sha256(code), { key: keyName, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Returns the key name once, then the code is gone. */
  redeem(code: unknown): string | undefined {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(code)) {
      return undefined;
    }
    const h = sha256(code);
    const found = this.codes.get(h);
    if (!found) return undefined;
    this.codes.delete(h);
    return found.expiresAt > this.now() ? found.key : undefined;
  }
}
