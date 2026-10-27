import crypto from "crypto";
import { DashboardUser } from "../config";
import { hashPassword, verifyPassword } from "./password";

export const SESSION_COOKIE = "relay_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

/**
 * In-memory sessions: a restart or deploy signs everyone out, which is fine
 * for an admin page and keeps this free of any database. Only the hash of a
 * token is kept, so a memory dump doesn't hand out live sessions.
 */
export class SessionStore {
  private sessions = new Map<string, { username: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  create(username: string): string {
    const token = crypto.randomBytes(32).toString("hex");
    this.sessions.set(sha256(token), {
      username,
      expiresAt: this.now() + SESSION_TTL_MS,
    });
    return token;
  }

  get(token: string): string | undefined {
    const id = sha256(token);
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.now() >= s.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return s.username;
  }

  destroy(token: string): void {
    this.sessions.delete(sha256(token));
  }
}

/** Counts failed logins per client IP; a success clears the count. */
export class LoginThrottle {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  blocked(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (this.now() >= f.resetAt) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= LOGIN_FAILURE_LIMIT;
  }

  fail(ip: string): void {
    const f = this.failures.get(ip);
    if (!f || this.now() >= f.resetAt) {
      this.failures.set(ip, {
        count: 1,
        resetAt: this.now() + LOGIN_WINDOW_MS,
      });
    } else f.count++;
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Checks a username and password. An unknown username still pays for one
 * password hash, so response time doesn't reveal which usernames exist.
 */
export async function checkLogin(
  users: DashboardUser[],
  username: unknown,
  password: unknown,
): Promise<string | undefined> {
  const name =
    typeof username === "string" ? username.trim().toLowerCase() : "";
  const pass = typeof password === "string" ? password : "";
  const user = users.find((u) => u.username.toLowerCase() === name);
  dummyHash ??= hashPassword("not-a-real-password");
  const ok = await verifyPassword(
    pass,
    user ? user["password-hash"] : await dummyHash,
  );
  return user && ok ? user.username : undefined;
}
