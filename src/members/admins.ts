import crypto from "crypto";
import { AdminInvite, DashboardUser, EMAIL_RE } from "../config";
import { hashPassword } from "../auth/password";
import { KeyStoreError } from "../keys/store";
import {
  INVITE_TTL_MS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./store";

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

export interface AdminLoginsOptions {
  persistUsers?: (users: DashboardUser[]) => void;
  persistInvites?: (invites: AdminInvite[]) => void;
  now?: () => number;
}

/**
 * The people who sign in to the admin dashboard, and the one-time links that
 * add them. Separate from teammate sign-ins on purpose: they are a different
 * level of trust and share no code path with the account page.
 */
export class AdminLogins {
  private users: DashboardUser[];
  private invites: AdminInvite[];

  constructor(
    users: DashboardUser[],
    invites: AdminInvite[],
    private readonly opts: AdminLoginsOptions = {},
  ) {
    this.users = users.map((u) => ({ ...u }));
    this.invites = invites.map((i) => ({ ...i }));
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private live(i: AdminInvite): boolean {
    return Date.parse(i["expires-at"]) > this.now();
  }

  list(): DashboardUser[] {
    return this.users.map((u) => ({ ...u }));
  }

  has(username: string): boolean {
    const n = username.toLowerCase();
    return this.users.some((u) => u.username.toLowerCase() === n);
  }

  pending(): AdminInvite[] {
    return this.invites.filter((i) => this.live(i)).map((i) => ({ ...i }));
  }

  invite(email: unknown, by: string): { token: string; invite: AdminInvite } {
    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      throw new KeyStoreError(400, "enter the person's email address");
    }
    const mail = email.trim().toLowerCase();
    const token = crypto.randomBytes(32).toString("base64url");
    const at = this.now();
    const invite: AdminInvite = {
      "token-hash": sha256(token),
      email: mail,
      "created-at": new Date(at).toISOString(),
      "expires-at": new Date(at + INVITE_TTL_MS).toISOString(),
      "created-by": by,
    };
    this.commitInvites([
      ...this.invites.filter((i) => i.email !== mail),
      invite,
    ]);
    console.log(`[team] ${by} invited ${mail} to sign in to the dashboard`);
    return { token, invite };
  }

  async accept(token: unknown, password: unknown): Promise<string> {
    if (typeof token !== "string" || !token) {
      throw new KeyStoreError(400, "this link is not valid");
    }
    const found = this.invites.find((i) => i["token-hash"] === sha256(token));
    if (!found) {
      throw new KeyStoreError(
        400,
        "this link is not valid, or it was already used. Ask for a new one.",
      );
    }
    if (!this.live(found)) {
      this.commitInvites(this.invites.filter((i) => i !== found));
      throw new KeyStoreError(410, "this link has expired. Ask for a new one.");
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new KeyStoreError(
        400,
        `choose a password of at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new KeyStoreError(400, "that password is too long");
    }
    const user: DashboardUser = {
      username: found.email,
      "password-hash": await hashPassword(password),
    };
    this.commitInvites(this.invites.filter((i) => i !== found));
    this.commitUsers([
      ...this.users.filter((u) => u.username.toLowerCase() !== found.email),
      user,
    ]);
    return user.username;
  }

  remove(username: string, by: string): void {
    const n = username.toLowerCase();
    const found = this.users.find((u) => u.username.toLowerCase() === n);
    if (!found)
      throw new KeyStoreError(404, `no dashboard login for ${username}`);
    if (this.users.length <= 1) {
      throw new KeyStoreError(
        409,
        "that is the only dashboard login, and removing it would lock everyone out of this page",
      );
    }
    this.commitUsers(this.users.filter((u) => u !== found));
    console.log(
      `[team] ${by} removed the dashboard login for ${found.username}`,
    );
  }

  cancelInvite(email: string): void {
    const n = email.toLowerCase();
    if (!this.invites.some((i) => i.email === n && this.live(i))) {
      throw new KeyStoreError(404, `no waiting invite for ${email}`);
    }
    this.commitInvites(this.invites.filter((i) => i.email !== n));
  }

  private commitUsers(next: DashboardUser[]): void {
    try {
      this.opts.persistUsers?.(next);
    } catch (err: any) {
      throw new KeyStoreError(500, `could not save config: ${err.message}`);
    }
    this.users = next;
  }

  private commitInvites(proposed: AdminInvite[]): void {
    const next = proposed.filter((i) => this.live(i));
    try {
      this.opts.persistInvites?.(next);
    } catch (err: any) {
      throw new KeyStoreError(500, `could not save config: ${err.message}`);
    }
    this.invites = next;
  }
}
