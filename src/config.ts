import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { PASSWORD_HASH_RE } from "./auth/password";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
  /**
   * Codex (ChatGPT) provider — protocol-required headers, NOT identity faking.
   * Strings live here so upstream flag-name drift can ship as a YAML edit.
   */
  codex?: {
    "user-agent"?: string;
    originator?: string;
    "cli-version"?: string;
    /** Optional: only set if upstream begins requiring an OpenAI-Beta header. */
    "openai-beta"?: string;
  };
  /**
   * Cursor provider — reverse-engineered, unstable headers for personal local
   * experiments only. Cursor version-gates requests, so keep these overrideable.
   */
  cursor?: {
    "client-version"?: string;
    "client-type"?: string;
    "agent-base-url"?: string;
    "api-base-url"?: string;
    "config-version"?: string;
    timezone?: string;
    "ghost-mode"?: string;
  };
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export interface StatsConfig {
  /** Default true. Set false to disable per-request stats recording entirely. */
  enabled: boolean;
}

export type DebugMode = "off" | "errors" | "verbose";

/**
 * One client credential. `name` is the human label every usage report uses.
 * `models` is a required allowlist (`["*"]` = any model), matched against the
 * alias-resolved model name. `daily-token-limit` caps input+output tokens per
 * UTC day (soft: in-flight requests can overshoot it). `admin` unlocks /admin/*.
 */
export interface ApiKeyEntry {
  name: string;
  key: string;
  models: string[];
  "daily-token-limit"?: number;
  disabled?: boolean;
  admin?: boolean;
  grants?: KeyGrant[];
}

/**
 * Temporary extra model access for one key. It adds to `models` until `until`
 * and then stops applying; expired grants are kept for a day so the error a
 * caller gets can say the access just ended.
 */
export interface KeyGrant {
  id: string;
  models: string[];
  until: string;
  "granted-at": string;
  note?: string;
}

/**
 * Someone with a key asking for temporary access to models it does not have.
 * An admin approves (which creates an ordinary grant) or rejects it.
 */
export type AccessRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";

export interface AccessRequest {
  id: string;
  /** Name of the key that asked. */
  key: string;
  models: string[];
  /** Why they need it; required, shown to whoever decides. */
  reason: string;
  /** How long they asked for. The approver may change it. */
  minutes: number;
  status: AccessRequestStatus;
  "requested-at": string;
  "decided-at"?: string;
  "decided-by"?: string;
  /** Why it was rejected, or a remark when approved. */
  "decision-note"?: string;
  /** When the approved access ends. */
  until?: string;
}

export type ModelAccess = "standard" | "on_request";

/**
 * Special entry for a key's `models` list: every model the model list marks
 * "standard", now and whenever the list changes. Keeps "cheap models by
 * default, the rest on request" true without editing every key.
 */
export const STANDARD_GROUP = "@standard";

/** OpenCode Go: a pool of API keys, one per Go subscription. */
export interface OpenCodeGoConfig {
  keys: string[];
  /** Default https://opencode.ai/inference/go. Tests point it at a stand-in. */
  "base-url"?: string;
}

/**
 * A model the relay can serve, as the admin UI and the setup scripts see it.
 * `on_request` models are listed (labelled) for every key so access can be
 * granted later without anyone re-running setup.
 */
export interface CatalogModel {
  id: string;
  name: string;
  access: ModelAccess;
}

export interface DashboardUser {
  username: string;
  "password-hash": string;
}

/**
 * A teammate who signs in to the account page. One person per key, so
 * everything the page shows or does is scoped to that key and never takes a
 * key name from the browser.
 */
export interface Member {
  email: string;
  key: string;
  "password-hash": string;
}

/** A one-time link that lets someone set a password for a key. Only the hash of the token is kept. */
export interface Invite {
  "token-hash": string;
  key: string;
  email: string;
  "created-at": string;
  "expires-at": string;
  "created-by": string;
}

/** A one-time link that lets a teammate become a dashboard admin. Only the hash of the token is kept. */
export interface AdminInvite {
  "token-hash": string;
  email: string;
  "created-at": string;
  "expires-at": string;
  "created-by": string;
}

export interface SlackConfig {
  "bot-token": string;
  /** Channel id, for example C0BBNMMCS49. */
  channel: string;
  /** Default https://slack.com/api. Tests point it at a stand-in. */
  "api-base"?: string;
}

export interface NotificationsConfig {
  slack?: SlackConfig;
}

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": ApiKeyEntry[];
  "dashboard-users"?: DashboardUser[];
  models?: CatalogModel[];
  "opencode-go"?: OpenCodeGoConfig;
  "access-requests"?: AccessRequest[];
  members?: Member[];
  invites?: Invite[];
  "admin-invites"?: AdminInvite[];
  notifications?: NotificationsConfig;
  /** The address people use to reach this relay, for links in messages. No trailing slash. */
  "public-url"?: string;
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  stats: StatsConfig;
  debug: DebugMode;
}

const DEFAULT_RAW: Config = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  "body-limit": "200mb",
  cloaking: {
    "cli-version": "2.1.88",
    entrypoint: "cli",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  stats: {
    enabled: true,
  },
  debug: "off",
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export const KEY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

/** Validates one api-keys entry; throws with a message naming the problem. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const GRANT_ID_RE = /^[a-f0-9]{8}$/;

export function isValidModelId(id: unknown): id is string {
  return typeof id === "string" && MODEL_ID_RE.test(id);
}

export function validateGrants(list: unknown, where: string): KeyGrant[] {
  if (!Array.isArray(list)) throw new Error(`${where}: grants must be a list`);
  return list.map((g, i) => {
    const w = `${where}.grants[${i}]`;
    const o = (g ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || !GRANT_ID_RE.test(o.id)) {
      throw new Error(`${w}: id must be 8 hex characters`);
    }
    if (
      !Array.isArray(o.models) ||
      o.models.length === 0 ||
      o.models.length > 50 ||
      !o.models.every(isValidModelId)
    ) {
      throw new Error(`${w}: models must be a non-empty list of model names`);
    }
    for (const field of ["until", "granted-at"]) {
      const v = o[field];
      if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
        throw new Error(`${w}: ${field} must be a timestamp`);
      }
    }
    if (
      o.note !== undefined &&
      (typeof o.note !== "string" || o.note.length > 200)
    ) {
      throw new Error(`${w}: note must be text of at most 200 characters`);
    }
    const grant: KeyGrant = {
      id: o.id,
      models: o.models as string[],
      until: new Date(Date.parse(o.until as string)).toISOString(),
      "granted-at": new Date(
        Date.parse(o["granted-at"] as string),
      ).toISOString(),
    };
    if (typeof o.note === "string" && o.note.trim()) grant.note = o.note.trim();
    return grant;
  });
}

const REQUEST_STATUSES: AccessRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
];

export function validateAccessRequests(list: unknown): AccessRequest[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("access-requests must be a list");
  return list.map((r, i) => {
    const w = `access-requests[${i}]`;
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || !GRANT_ID_RE.test(o.id)) {
      throw new Error(`${w}: id must be 8 hex characters`);
    }
    if (typeof o.key !== "string" || !KEY_NAME_RE.test(o.key)) {
      throw new Error(`${w}: key must be a key name`);
    }
    if (
      !Array.isArray(o.models) ||
      o.models.length === 0 ||
      !o.models.every(isValidModelId)
    ) {
      throw new Error(`${w}: models must be a non-empty list of model names`);
    }
    if (typeof o.reason !== "string" || !o.reason.trim()) {
      throw new Error(`${w}: reason is required`);
    }
    if (typeof o.minutes !== "number" || !Number.isInteger(o.minutes)) {
      throw new Error(`${w}: minutes must be a whole number`);
    }
    if (!REQUEST_STATUSES.includes(o.status as AccessRequestStatus)) {
      throw new Error(
        `${w}: status must be one of ${REQUEST_STATUSES.join(", ")}`,
      );
    }
    for (const field of ["requested-at", "decided-at", "until"]) {
      const v = o[field];
      if (
        v !== undefined &&
        (typeof v !== "string" || Number.isNaN(Date.parse(v)))
      ) {
        throw new Error(`${w}: ${field} must be a timestamp`);
      }
    }
    if (o["requested-at"] === undefined) {
      throw new Error(`${w}: requested-at is required`);
    }
    const out: AccessRequest = {
      id: o.id,
      key: o.key,
      models: o.models as string[],
      reason: o.reason,
      minutes: o.minutes,
      status: o.status as AccessRequestStatus,
      "requested-at": o["requested-at"] as string,
    };
    for (const field of [
      "decided-at",
      "decided-by",
      "decision-note",
      "until",
    ] as const) {
      if (typeof o[field] === "string") out[field] = o[field] as string;
    }
    return out;
  });
}

export function validateCatalogModel(m: unknown, where: string): CatalogModel {
  const o = (m ?? {}) as Record<string, unknown>;
  if (!isValidModelId(o.id)) {
    throw new Error(
      `${where}: id must be a model name (letters, digits, . _ : / -)`,
    );
  }
  if (
    typeof o.name !== "string" ||
    !o.name.trim() ||
    o.name.length > 80 ||
    /[\u0000-\u001f]/.test(o.name)
  ) {
    throw new Error(`${where}: name must be 1 to 80 characters of plain text`);
  }
  const access = o.access ?? "standard";
  if (access !== "standard" && access !== "on_request") {
    throw new Error(`${where}: access must be "standard" or "on_request"`);
  }
  return { id: o.id, name: o.name.trim(), access };
}

export function validateOpenCodeGo(raw: unknown): OpenCodeGoConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("opencode-go must be a mapping with a keys list");
  }
  if (!Array.isArray(o.keys))
    throw new Error("opencode-go.keys must be a list");
  const seen = new Set<string>();
  const keys = o.keys.map((k, i) => {
    if (typeof k !== "string" || k.trim().length < 20 || /\s/.test(k.trim())) {
      throw new Error(
        `opencode-go.keys[${i}] must be a key of at least 20 characters`,
      );
    }
    const key = k.trim();
    if (seen.has(key)) throw new Error(`opencode-go.keys[${i}] is a duplicate`);
    seen.add(key);
    return key;
  });
  const out: OpenCodeGoConfig = { keys };
  if (o["base-url"] !== undefined) {
    if (
      typeof o["base-url"] !== "string" ||
      !/^https?:\/\//.test(o["base-url"])
    ) {
      throw new Error("opencode-go.base-url must be an http(s) address");
    }
    out["base-url"] = o["base-url"].replace(/\/+$/, "");
  }
  return out;
}

export function validateCatalog(list: unknown): CatalogModel[] | undefined {
  if (list === undefined || list === null) return undefined;
  if (!Array.isArray(list)) throw new Error("models must be a list");
  const seen = new Set<string>();
  return list.map((m, i) => {
    const model = validateCatalogModel(m, `models[${i}]`);
    const k = model.id.toLowerCase();
    if (seen.has(k)) throw new Error(`models: duplicate id "${model.id}"`);
    seen.add(k);
    return model;
  });
}

export function validateApiKeyEntry(e: unknown, where: string): ApiKeyEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    throw new Error(
      `${where}: api-keys entries must be objects {name, key, models}, not plain strings`,
    );
  }
  const o = e as Record<string, unknown>;
  if (typeof o.name !== "string" || !KEY_NAME_RE.test(o.name)) {
    throw new Error(`${where}: name must match ${KEY_NAME_RE}`);
  }
  if (typeof o.key !== "string" || o.key.length < 16) {
    throw new Error(`${where}: key must be a string of at least 16 characters`);
  }
  if (
    !Array.isArray(o.models) ||
    o.models.length === 0 ||
    o.models.some((m) => typeof m !== "string" || !m)
  ) {
    throw new Error(
      `${where}: models must be a non-empty list of model names (use ["*"] for any)`,
    );
  }
  const limit = o["daily-token-limit"];
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)
  ) {
    throw new Error(`${where}: daily-token-limit must be a positive integer`);
  }
  for (const flag of ["disabled", "admin"]) {
    if (o[flag] !== undefined && typeof o[flag] !== "boolean") {
      throw new Error(`${where}: ${flag} must be true or false`);
    }
  }
  const grants = o.grants === undefined ? [] : validateGrants(o.grants, where);
  const entry: ApiKeyEntry = {
    name: o.name,
    key: o.key,
    models: o.models as string[],
  };
  if (grants.length) entry.grants = grants;
  if (limit !== undefined) entry["daily-token-limit"] = limit as number;
  if (o.disabled === true) entry.disabled = true;
  if (o.admin === true) entry.admin = true;
  return entry;
}

export function validateApiKeys(list: unknown): ApiKeyEntry[] {
  if (!Array.isArray(list)) throw new Error("api-keys must be a list");
  const entries = list.map((e, i) => validateApiKeyEntry(e, `api-keys[${i}]`));
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (names.has(n)) throw new Error(`api-keys: duplicate name "${e.name}"`);
    if (keys.has(e.key))
      throw new Error(`api-keys: duplicate key for "${e.name}"`);
    names.add(n);
    keys.add(e.key);
  }
  return entries;
}

export const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>"]{2,}$/;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/;

export function validateMembers(list: unknown): Member[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("members must be a list");
  const seenEmail = new Set<string>();
  const seenKey = new Set<string>();
  return list.map((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>;
    const where = `members[${i}]`;
    if (typeof o.email !== "string" || !EMAIL_RE.test(o.email)) {
      throw new Error(`${where}: email must be an email address`);
    }
    if (typeof o.key !== "string" || !KEY_NAME_RE.test(o.key)) {
      throw new Error(`${where}: key must be a key name`);
    }
    if (
      typeof o["password-hash"] !== "string" ||
      !PASSWORD_HASH_RE.test(o["password-hash"])
    ) {
      throw new Error(`${where}: password-hash must be a scrypt hash`);
    }
    const email = o.email.toLowerCase();
    if (seenEmail.has(email))
      throw new Error(`members: duplicate email "${email}"`);
    if (seenKey.has(o.key.toLowerCase())) {
      throw new Error(`members: more than one sign-in for key "${o.key}"`);
    }
    seenEmail.add(email);
    seenKey.add(o.key.toLowerCase());
    return { email, key: o.key, "password-hash": o["password-hash"] };
  });
}

export function validateInvites(list: unknown): Invite[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("invites must be a list");
  return list.map((v, i) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const where = `invites[${i}]`;
    if (
      typeof o["token-hash"] !== "string" ||
      !TOKEN_HASH_RE.test(o["token-hash"])
    ) {
      throw new Error(`${where}: token-hash must be a sha256 hex string`);
    }
    if (typeof o.key !== "string" || !KEY_NAME_RE.test(o.key)) {
      throw new Error(`${where}: key must be a key name`);
    }
    if (typeof o.email !== "string" || !EMAIL_RE.test(o.email)) {
      throw new Error(`${where}: email must be an email address`);
    }
    for (const f of ["created-at", "expires-at"]) {
      const t = o[f];
      if (typeof t !== "string" || Number.isNaN(Date.parse(t))) {
        throw new Error(`${where}: ${f} must be a timestamp`);
      }
    }
    return {
      "token-hash": o["token-hash"],
      key: o.key,
      email: o.email.toLowerCase(),
      "created-at": o["created-at"] as string,
      "expires-at": o["expires-at"] as string,
      "created-by":
        typeof o["created-by"] === "string" ? o["created-by"] : "an admin",
    };
  });
}

export function validateAdminInvites(list: unknown): AdminInvite[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("admin-invites must be a list");
  return list.map((v, i) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const where = `admin-invites[${i}]`;
    if (
      typeof o["token-hash"] !== "string" ||
      !TOKEN_HASH_RE.test(o["token-hash"])
    ) {
      throw new Error(`${where}: token-hash must be a sha256 hex string`);
    }
    if (typeof o.email !== "string" || !EMAIL_RE.test(o.email)) {
      throw new Error(`${where}: email must be an email address`);
    }
    for (const f of ["created-at", "expires-at"]) {
      const t = o[f];
      if (typeof t !== "string" || Number.isNaN(Date.parse(t))) {
        throw new Error(`${where}: ${f} must be a timestamp`);
      }
    }
    return {
      "token-hash": o["token-hash"],
      email: o.email.toLowerCase(),
      "created-at": o["created-at"] as string,
      "expires-at": o["expires-at"] as string,
      "created-by":
        typeof o["created-by"] === "string" ? o["created-by"] : "an admin",
    };
  });
}

export function validateNotifications(
  value: unknown,
): NotificationsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const o = value as Record<string, any>;
  if (typeof o !== "object" || Array.isArray(o)) {
    throw new Error("notifications must be a mapping");
  }
  const out: NotificationsConfig = {};
  if (o.slack !== undefined && o.slack !== null) {
    const sl = o.slack as Record<string, unknown>;
    if (typeof sl["bot-token"] !== "string" || !sl["bot-token"].trim()) {
      throw new Error(
        "notifications.slack.bot-token must be a non-empty string",
      );
    }
    if (
      typeof sl.channel !== "string" ||
      !/^[A-Z0-9]{6,20}$/.test(sl.channel)
    ) {
      throw new Error(
        "notifications.slack.channel must be a Slack channel id (like C0BBNMMCS49)",
      );
    }
    const slack: SlackConfig = {
      "bot-token": sl["bot-token"].trim(),
      channel: sl.channel,
    };
    if (sl["api-base"] !== undefined) {
      if (
        typeof sl["api-base"] !== "string" ||
        !/^https?:\/\//.test(sl["api-base"])
      ) {
        throw new Error("notifications.slack.api-base must be an http(s) URL");
      }
      slack["api-base"] = sl["api-base"].replace(/\/+$/, "");
    }
    out.slack = slack;
  }
  return out;
}

export function validatePublicUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^https?:\/\/[^\s/]+$/.test(value.replace(/\/+$/, ""))
  ) {
    throw new Error("public-url must look like https://relay.example.com");
  }
  return value.replace(/\/+$/, "");
}

export function validateDashboardUsers(list: unknown): DashboardUser[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("dashboard-users must be a list");
  const seen = new Set<string>();
  return list.map((u, i) => {
    const o = (u ?? {}) as Record<string, unknown>;
    const where = `dashboard-users[${i}]`;
    if (typeof o.username !== "string" || !o.username.trim()) {
      throw new Error(`${where}: username must be a non-empty string`);
    }
    if (
      typeof o["password-hash"] !== "string" ||
      !PASSWORD_HASH_RE.test(o["password-hash"])
    ) {
      throw new Error(
        `${where}: password-hash must be a scrypt hash (make one with --hash-password)`,
      );
    }
    const name = o.username.trim().toLowerCase();
    if (seen.has(name))
      throw new Error(`dashboard-users: duplicate username "${o.username}"`);
    seen.add(name);
    return { username: o.username.trim(), "password-hash": o["password-hash"] };
  });
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let raw: Config;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as Partial<Config>;
    raw = {
      ...DEFAULT_RAW,
      ...parsed,
      cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
      stats: { ...DEFAULT_RAW.stats, ...(parsed.stats || {}) },
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);

  // Auto-generate an admin key if none configured
  if (!raw["api-keys"] || raw["api-keys"].length === 0) {
    const key = generateApiKey();
    raw["api-keys"] = [{ name: "admin", key, models: ["*"], admin: true }];
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  raw["api-keys"] = validateApiKeys(raw["api-keys"]);
  raw["dashboard-users"] = validateDashboardUsers(raw["dashboard-users"]);
  raw.models = validateCatalog(raw.models);
  raw["opencode-go"] = validateOpenCodeGo(raw["opencode-go"]);
  raw["access-requests"] = validateAccessRequests(raw["access-requests"]);
  raw.members = validateMembers(raw.members);
  raw.invites = validateInvites(raw.invites);
  raw.notifications = validateNotifications(raw.notifications);
  raw["public-url"] = validatePublicUrl(raw["public-url"]);
  const keyNames = new Set(raw["api-keys"].map((k) => k.name.toLowerCase()));
  const keep = <T extends { key: string; email: string }>(
    items: T[],
    what: string,
  ) =>
    items.filter((x) => {
      const ok = keyNames.has(x.key.toLowerCase());
      if (!ok)
        console.warn(
          `[config] ignoring ${what} for ${x.email}: key "${x.key}" no longer exists`,
        );
      return ok;
    });
  raw.members = keep(raw.members, "sign-in");
  raw.invites = keep(raw.invites, "invite");
  raw["admin-invites"] = validateAdminInvites(raw["admin-invites"]);
  if (
    !raw.stats.enabled &&
    raw["api-keys"].some((k) => k["daily-token-limit"] !== undefined)
  ) {
    throw new Error(
      "api-keys: daily-token-limit needs stats.enabled (usage is read from the stats log)",
    );
  }
  return raw;
}

function persistSection(
  filePath: string,
  section: string,
): (value: unknown) => void {
  return (value) => {
    const parsed = fs.existsSync(filePath)
      ? ((yaml.load(fs.readFileSync(filePath, "utf-8")) as Record<
          string,
          unknown
        >) ?? {})
      : {};
    parsed[section] = value;
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, yaml.dump(parsed, { lineWidth: -1 }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, filePath);
  };
}

export function persistApiKeys(
  filePath: string,
): (entries: ApiKeyEntry[]) => void {
  return persistSection(filePath, "api-keys");
}

export function persistAccessRequests(
  filePath: string,
): (requests: AccessRequest[]) => void {
  return persistSection(filePath, "access-requests");
}

export function persistMembers(filePath: string): (members: Member[]) => void {
  return persistSection(filePath, "members");
}

export function persistInvites(filePath: string): (invites: Invite[]) => void {
  return persistSection(filePath, "invites");
}

export function persistDashboardUsers(
  filePath: string,
): (users: DashboardUser[]) => void {
  return persistSection(filePath, "dashboard-users");
}

export function persistAdminInvites(
  filePath: string,
): (invites: AdminInvite[]) => void {
  return persistSection(filePath, "admin-invites");
}

export function persistCatalog(
  filePath: string,
): (models: CatalogModel[]) => void {
  return persistSection(filePath, "models");
}
