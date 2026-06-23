// Minimal platform account boundary.
//
// The control plane needs a concrete owner identity for room scoping, metering,
// and later billing, but production login/provider setup remains an operator
// gate. This module defines that owner/account shape and a configurable local
// development identity without storing room messages, invite URLs, or bearer
// tokens.

export interface PlatformExternalIdentity {
  provider: string;
  subject: string;
}

export interface PlatformAccount {
  user_id: string;
  display_name: string;
  email: string | null;
  external_identity: PlatformExternalIdentity | null;
  created_at: string;
  updated_at: string;
}

export interface DevOwnerIdentityConfig {
  userId?: string;
  displayName?: string;
  email?: string | null;
  externalIdentity?: PlatformExternalIdentity | null;
  now?: Date;
}

export interface PlatformOwnerQuery {
  /** Concrete account supplied by a future production auth/session layer. */
  account?: PlatformAccount;
  /** Local/dogfood identity for tests and operator-run control-plane shells. */
  dev_owner?: DevOwnerIdentityConfig;
  /** Backward-compatible owner id shorthand for existing local tests/callers. */
  owner_user_id?: string;
}

export class PlatformAccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAccountValidationError";
  }
}

export const DEFAULT_DEV_OWNER_ID = "local-owner";
export const DEFAULT_DEV_OWNER_DISPLAY_NAME = "Local Owner";

export const DEV_OWNER_ENV = {
  userId: "AGENTGATHER_DEV_OWNER_ID",
  displayName: "AGENTGATHER_DEV_OWNER_NAME",
  email: "AGENTGATHER_DEV_OWNER_EMAIL",
  provider: "AGENTGATHER_DEV_OWNER_PROVIDER",
  subject: "AGENTGATHER_DEV_OWNER_SUBJECT"
} as const;

const ACCOUNT_KEYS = new Set(["user_id", "display_name", "email", "external_identity", "created_at", "updated_at"]);
const EXTERNAL_IDENTITY_KEYS = new Set(["provider", "subject"]);
const FORBIDDEN_KEYS = new Set([
  "message",
  "messages",
  "text",
  "body",
  "brief",
  "brief_body",
  "content",
  "token",
  "tokens",
  "token_hash",
  "bearer",
  "authorization",
  "invite_url",
  "card_url",
  "request_body",
  "response_body"
]);

const SAFE_USER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 320;

export function createDevOwnerAccount(config: DevOwnerIdentityConfig = {}): PlatformAccount {
  const now = (config.now ?? new Date()).toISOString();
  const userId = asUserId(config.userId ?? DEFAULT_DEV_OWNER_ID);
  return {
    user_id: userId,
    display_name: asDisplayName(config.displayName ?? DEFAULT_DEV_OWNER_DISPLAY_NAME),
    email: asNullableEmail(config.email ?? null),
    external_identity: config.externalIdentity === undefined ? null : asNullableExternalIdentity(config.externalIdentity),
    created_at: now,
    updated_at: now
  };
}

export function devOwnerIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): DevOwnerIdentityConfig {
  const provider = env[DEV_OWNER_ENV.provider];
  const subject = env[DEV_OWNER_ENV.subject];
  if ((provider === undefined) !== (subject === undefined)) {
    throw new PlatformAccountValidationError(
      `${DEV_OWNER_ENV.provider} and ${DEV_OWNER_ENV.subject} must be configured together`
    );
  }
  const config: DevOwnerIdentityConfig = {};
  const userId = env[DEV_OWNER_ENV.userId];
  if (userId !== undefined) config.userId = userId;
  const displayName = env[DEV_OWNER_ENV.displayName];
  if (displayName !== undefined) config.displayName = displayName;
  const email = env[DEV_OWNER_ENV.email];
  if (email !== undefined) config.email = email === "" ? null : email;
  if (provider !== undefined && subject !== undefined) {
    config.externalIdentity = { provider, subject };
  }
  return config;
}

export function resolveOwnerAccount(query: PlatformOwnerQuery): PlatformAccount | null {
  if (query.account !== undefined) return sanitizeAccount(query.account);
  if (query.dev_owner !== undefined) return createDevOwnerAccount(query.dev_owner);
  if (query.owner_user_id !== undefined) {
    return createDevOwnerAccount({ userId: query.owner_user_id, displayName: query.owner_user_id });
  }
  return null;
}

export function sanitizeAccount(input: unknown): PlatformAccount {
  const record = asRecord(input, "account");
  assertNoForbiddenKeys(record, "account");
  for (const key of Object.keys(record)) {
    if (!ACCOUNT_KEYS.has(key)) throw new PlatformAccountValidationError(`account has unsupported field ${key}`);
  }
  const createdAt = asTimestamp(record.created_at, "account.created_at");
  const updatedAt = asTimestamp(record.updated_at, "account.updated_at");
  return {
    user_id: asUserId(record.user_id),
    display_name: asDisplayName(record.display_name),
    email: asNullableEmail(record.email),
    external_identity: asNullableExternalIdentity(record.external_identity),
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function asNullableExternalIdentity(value: unknown): PlatformExternalIdentity | null {
  if (value === null) return null;
  const record = asRecord(value, "external_identity");
  assertNoForbiddenKeys(record, "external_identity");
  for (const key of Object.keys(record)) {
    if (!EXTERNAL_IDENTITY_KEYS.has(key)) {
      throw new PlatformAccountValidationError(`external_identity has unsupported field ${key}`);
    }
  }
  const provider = asString(record.provider, "external_identity.provider");
  const subject = asString(record.subject, "external_identity.subject");
  if (!SAFE_PROVIDER.test(provider)) {
    throw new PlatformAccountValidationError("external_identity.provider is invalid");
  }
  if (!SAFE_SUBJECT.test(subject) || /tgl_/.test(subject)) {
    throw new PlatformAccountValidationError("external_identity.subject is invalid");
  }
  return { provider, subject };
}

function asUserId(value: unknown): string {
  const userId = asString(value, "user_id");
  if (!SAFE_USER_ID.test(userId) || /tgl_/.test(userId)) {
    throw new PlatformAccountValidationError("user_id is invalid");
  }
  return userId;
}

function asDisplayName(value: unknown): string {
  const displayName = asString(value, "display_name").trim();
  if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new PlatformAccountValidationError("display_name is invalid");
  }
  return displayName;
}

function asNullableEmail(value: unknown): string | null {
  if (value === null) return null;
  const email = asString(value, "email").trim();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || /\s/.test(email) || !email.includes("@")) {
    throw new PlatformAccountValidationError("email is invalid");
  }
  return email;
}

function asTimestamp(value: unknown, field: string): string {
  const timestamp = asString(value, field);
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new PlatformAccountValidationError(`${field} is invalid`);
  }
  return timestamp;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new PlatformAccountValidationError(`${field} must be a string`);
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformAccountValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNoForbiddenKeys(record: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new PlatformAccountValidationError(`${context} must not carry canonical or sensitive field "${key}"`);
    }
  }
}
