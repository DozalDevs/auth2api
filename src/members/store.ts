import crypto from "crypto";
import { EMAIL_RE, Invite, Member } from "../config";
import { hashPassword, verifyPassword } from "../auth/password";
import { KeyStoreError } from "../keys/store";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s).digest("hex");

export interface MemberStoreOptions {
  /** The key's exact name when it exists, so links always point at a real key. */
  resolveKey: (name: string) => string | undefined;
  persistMembers?: (members: Member[]) => void;
  persistInvites?: (invites: Invite[]) => void;
  now?: () => number;
}

let dummyHash: Promise<string> | undefined;

/**
 * Teammates who sign in to the account page, and the one-time links that let
 * them set a password. One sign-in per key. Held in memory and written to the
 * config on every change, like the key list.
 */
export class MemberStore {
  private members: Member[];
  private invites: Invite[];

  constructor(
    members: Member[],
    invites: Invite[],
    private readonly opts: MemberStoreOptions,
  ) {
    this.members = members.map((m) => ({ ...m }));
    this.invites = invites.map((i) => ({ ...i }));
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private live(invite: Invite): boolean {
    return Date.parse(invite["expires-at"]) > this.now();
  }

  forKey(keyName: string): Member | undefined {
    const n = keyName.toLowerCase();
    return this.members.find((m) => m.key.toLowerCase() === n);
  }

  byEmail(email: string): Member | undefined {
    const e = email.trim().toLowerCase();
    return this.members.find((m) => m.email === e);
  }

  pendingInvite(keyName: string): Invite | undefined {
    const n = keyName.toLowerCase();
    return this.invites.find((i) => i.key.toLowerCase() === n && this.live(i));
  }

  /** Makes a one-time link for a key. A newer link replaces any older one for that key. */
  invite(
    keyName: string,
    email: unknown,
    by: string,
  ): { token: string; invite: Invite } {
    const key = this.opts.resolveKey(keyName);
    if (!key) throw new KeyStoreError(404, `no key named "${keyName}"`);
    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      throw new KeyStoreError(400, "enter the person's email address");
    }
    const mail = email.trim().toLowerCase();
    const holder = this.byEmail(mail);
    if (holder && holder.key.toLowerCase() !== key.toLowerCase()) {
      throw new KeyStoreError(409, `${mail} already signs in to another key`);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const at = this.now();
    const invite: Invite = {
      "token-hash": sha256(token),
      key,
      email: mail,
      "created-at": new Date(at).toISOString(),
      "expires-at": new Date(at + INVITE_TTL_MS).toISOString(),
      "created-by": by,
    };
    this.commitInvites([
      ...this.invites.filter((i) => i.key.toLowerCase() !== key.toLowerCase()),
      invite,
    ]);
    console.log(`[account] ${by} invited ${mail} to sign in as "${key}"`);
    return { token, invite };
  }

  /** Redeems a link: sets the password, and the link stops working. */
  async accept(token: unknown, password: unknown): Promise<Member> {
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
    const key = this.opts.resolveKey(found.key);
    if (!key) {
      this.commitInvites(this.invites.filter((i) => i !== found));
      throw new KeyStoreError(410, "that key no longer exists");
    }
    const holder = this.byEmail(found.email);
    if (holder && holder.key.toLowerCase() !== key.toLowerCase()) {
      throw new KeyStoreError(
        409,
        `${found.email} already signs in to another key`,
      );
    }
    const member: Member = {
      email: found.email,
      key,
      "password-hash": await hashPassword(password),
    };
    this.commitInvites(this.invites.filter((i) => i !== found));
    this.commitMembers([
      ...this.members.filter((m) => m.key.toLowerCase() !== key.toLowerCase()),
      member,
    ]);
    return { ...member };
  }

  /** Email and password. An unknown email still pays for one hash, so timing does not reveal who has an account. */
  async login(email: unknown, password: unknown): Promise<Member | undefined> {
    const mail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const pass = typeof password === "string" ? password : "";
    const member = this.byEmail(mail);
    dummyHash ??= hashPassword("not-a-real-password");
    const ok = await verifyPassword(
      pass.slice(0, MAX_PASSWORD_LENGTH),
      member ? member["password-hash"] : await dummyHash,
    );
    return member && ok ? { ...member } : undefined;
  }

  /** Takes away a key's sign-in and any waiting link. */
  removeForKey(keyName: string): boolean {
    const n = keyName.toLowerCase();
    const hadMember = this.members.some((m) => m.key.toLowerCase() === n);
    const hadInvite = this.invites.some((i) => i.key.toLowerCase() === n);
    if (hadInvite)
      this.commitInvites(this.invites.filter((i) => i.key.toLowerCase() !== n));
    if (hadMember)
      this.commitMembers(this.members.filter((m) => m.key.toLowerCase() !== n));
    return hadMember || hadInvite;
  }

  private commitMembers(next: Member[]): void {
    try {
      this.opts.persistMembers?.(next);
    } catch (err: any) {
      throw new KeyStoreError(500, `could not save config: ${err.message}`);
    }
    this.members = next;
  }

  private commitInvites(proposed: Invite[]): void {
    const next = proposed.filter((i) => this.live(i));
    try {
      this.opts.persistInvites?.(next);
    } catch (err: any) {
      throw new KeyStoreError(500, `could not save config: ${err.message}`);
    }
    this.invites = next;
  }
}
