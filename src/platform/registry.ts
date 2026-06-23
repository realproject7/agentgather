// File-backed control plane registry.
//
// Stores central room metadata as one secure JSON file per room under
// <root>/platform/rooms/<room_id>.json, reusing the same secure-fs and writer
// lock primitives as the host room store so the registry survives restart.
//
// The registry is the privacy boundary for the control plane: every record is
// rebuilt from an explicit allow-list of safe metadata fields, and inputs that
// carry message bodies, brief bodies, bearer tokens, token hashes, or tokenized
// URLs are rejected outright. Canonical room data never reaches disk here.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertSafeSlug, type ParticipantKind } from "../protocol/index.js";
import { ensureSecureDir, withWriterLock, writeSecureFile } from "../storage/index.js";
import {
  PLATFORM_ROOM_STATUSES,
  PLATFORM_STATUS_REASONS,
  type ControlPlaneRoom,
  type PlatformRoomStatus,
  type PlatformStatusReason,
  type RosterEntry,
  type RosterRole,
  type RouteHealth
} from "./types.js";

/** Raised when an input would store canonical room data or is malformed. */
export class ControlPlaneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneValidationError";
  }
}

/** Raised when a requested room has no central metadata record. */
export class ControlPlaneNotFoundError extends Error {
  constructor(roomId: string) {
    super(`no control plane metadata for room ${roomId}`);
    this.name = "ControlPlaneNotFoundError";
  }
}

// Keys that would carry canonical or sensitive room data. Their presence
// anywhere in an input (room or roster entry) is a hard rejection rather than a
// silent drop, so a caller cannot accidentally route content into the registry.
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

const ROSTER_KEYS = new Set(["alias", "kind", "role", "status", "last_seen_at"]);
const PARTICIPANT_KINDS = new Set<ParticipantKind>(["agent", "human", "system"]);
const ROSTER_ROLES = new Set<RosterRole>(["host", "member"]);
const SAFE_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TITLE_LENGTH = 200;

function platformDir(root: string): string {
  return path.join(root, "platform");
}

function roomsDir(root: string): string {
  return path.join(platformDir(root), "rooms");
}

function roomFile(root: string, roomId: string): string {
  assertSafeSlug(roomId, "room id");
  return path.join(roomsDir(root), `${roomId}.json`);
}

function lockPath(root: string): string {
  return path.join(platformDir(root), "registry.lock");
}

/**
 * Create a new central metadata record for a room. The input is validated and
 * rebuilt from safe fields only; it throws if a record already exists or if any
 * forbidden/canonical field is present.
 */
export async function createControlPlaneRoom(
  root: string,
  input: unknown,
  now: Date = new Date()
): Promise<ControlPlaneRoom> {
  const sanitized = sanitizeInput(input);
  const file = roomFile(root, sanitized.room_id);
  // The writer lock opens a file under platform/, so that directory must exist
  // before the lock is acquired.
  await ensureSecureDir(roomsDir(root));
  return withWriterLock(lockPath(root), async () => {
    if (await fileExists(file)) {
      throw new ControlPlaneValidationError(`control plane metadata already exists for room ${sanitized.room_id}`);
    }
    const iso = now.toISOString();
    const record: ControlPlaneRoom = { ...sanitized, created_at: iso, updated_at: iso };
    await writeRecord(file, record);
    return record;
  });
}

/** Read one room's central metadata, or throw ControlPlaneNotFoundError. */
export async function readControlPlaneRoom(root: string, roomId: string): Promise<ControlPlaneRoom> {
  const file = roomFile(root, roomId);
  try {
    return JSON.parse(await readFile(file, "utf8")) as ControlPlaneRoom;
  } catch (error) {
    if (isNotFoundError(error)) throw new ControlPlaneNotFoundError(roomId);
    throw error;
  }
}

/** List all central room metadata records, sorted by room id for determinism. */
export async function listControlPlaneRooms(root: string): Promise<ControlPlaneRoom[]> {
  let entries: string[];
  try {
    entries = await readdir(roomsDir(root));
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const ids = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  const rooms: ControlPlaneRoom[] = [];
  for (const id of ids) {
    rooms.push(await readControlPlaneRoom(root, id));
  }
  return rooms;
}

// Rebuild a ControlPlaneRoom (minus timestamps) from an untrusted input using a
// strict allow-list. Any forbidden key, anywhere, is rejected.
function sanitizeInput(input: unknown): Omit<ControlPlaneRoom, "created_at" | "updated_at"> {
  const record = asRecord(input, "room input");
  assertNoForbiddenKeys(record, "room input");

  const roomId = asString(record.room_id, "room_id");
  assertSafeSlug(roomId, "room_id");

  const routeUrl = asString(record.route_url, "route_url");
  assertTokenlessUrl(routeUrl);

  const routeSlug = record.route_slug === undefined ? roomId : asString(record.route_slug, "route_slug");
  assertSafeSlug(routeSlug, "route_slug");

  const result: Omit<ControlPlaneRoom, "created_at" | "updated_at"> = {
    room_id: roomId,
    title: asTitle(record.title),
    owner_user_id: asString(record.owner_user_id, "owner_user_id"),
    route_url: routeUrl,
    route_slug: routeSlug,
    status: asStatus(record.status),
    roster: asRoster(record.roster),
    route_health: asRouteHealth(record.route_health),
    last_synced_message_id: asCursor(record.last_synced_message_id)
  };
  const statusReason = asOptionalStatusReason(record.status_reason);
  if (statusReason !== undefined) result.status_reason = statusReason;
  const lastSeenAt = asOptionalTimestamp(record.last_seen_at, "last_seen_at");
  if (lastSeenAt !== undefined) result.last_seen_at = lastSeenAt;
  const lastSyncedAt = asOptionalTimestamp(record.last_synced_at, "last_synced_at");
  if (lastSyncedAt !== undefined) result.last_synced_at = lastSyncedAt;
  return result;
}

function asRoster(value: unknown): RosterEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ControlPlaneValidationError("roster must be an array");
  return value.map((entry, index) => {
    const record = asRecord(entry, `roster[${index}]`);
    assertNoForbiddenKeys(record, `roster[${index}]`);
    for (const key of Object.keys(record)) {
      if (!ROSTER_KEYS.has(key)) {
        throw new ControlPlaneValidationError(`roster[${index}] has unsupported field ${key}`);
      }
    }
    const alias = asString(record.alias, `roster[${index}].alias`);
    assertSafeSlug(alias, `roster[${index}].alias`);
    const kind = record.kind;
    if (typeof kind !== "string" || !PARTICIPANT_KINDS.has(kind as ParticipantKind)) {
      throw new ControlPlaneValidationError(`roster[${index}].kind is invalid`);
    }
    const role = record.role;
    if (typeof role !== "string" || !ROSTER_ROLES.has(role as RosterRole)) {
      throw new ControlPlaneValidationError(`roster[${index}].role is invalid`);
    }
    const status = asLabel(record.status, `roster[${index}].status`);
    const built: RosterEntry = { alias, kind: kind as ParticipantKind, role: role as RosterRole, status };
    const lastSeenAt = asOptionalTimestamp(record.last_seen_at, `roster[${index}].last_seen_at`);
    if (lastSeenAt !== undefined) built.last_seen_at = lastSeenAt;
    return built;
  });
}

function asRouteHealth(value: unknown): RouteHealth {
  if (value === undefined) return { reachable: false, host_connected: false };
  const record = asRecord(value, "route_health");
  assertNoForbiddenKeys(record, "route_health");
  if (typeof record.reachable !== "boolean" || typeof record.host_connected !== "boolean") {
    throw new ControlPlaneValidationError("route_health.reachable and host_connected must be booleans");
  }
  const built: RouteHealth = { reachable: record.reachable, host_connected: record.host_connected };
  const checkedAt = asOptionalTimestamp(record.checked_at, "route_health.checked_at");
  if (checkedAt !== undefined) built.checked_at = checkedAt;
  return built;
}

function assertNoForbiddenKeys(record: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new ControlPlaneValidationError(`${context} must not carry canonical or sensitive field "${key}"`);
    }
  }
}

// A route URL may name a room but must never embed a bearer token, so reject
// tokenized query params, fragments, or token-prefixed values outright.
function assertTokenlessUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlPlaneValidationError("route_url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ControlPlaneValidationError("route_url must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ControlPlaneValidationError("route_url must not embed credentials");
  }
  if (url.searchParams.has("token") || url.hash.includes("token=")) {
    throw new ControlPlaneValidationError("route_url must not embed a token");
  }
  if (/tgl_/.test(value)) {
    throw new ControlPlaneValidationError("route_url must not embed a token");
  }
}

function asStatus(value: unknown): PlatformRoomStatus {
  if (typeof value !== "string" || !PLATFORM_ROOM_STATUSES.includes(value as PlatformRoomStatus)) {
    throw new ControlPlaneValidationError(
      `status must be one of ${PLATFORM_ROOM_STATUSES.join(", ")}`
    );
  }
  return value as PlatformRoomStatus;
}

function asOptionalStatusReason(value: unknown): PlatformStatusReason | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PLATFORM_STATUS_REASONS.includes(value as PlatformStatusReason)) {
    throw new ControlPlaneValidationError(`status_reason must be one of ${PLATFORM_STATUS_REASONS.join(", ")}`);
  }
  return value as PlatformStatusReason;
}

function asCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneValidationError("last_synced_message_id must be a non-negative integer cursor");
  }
  return value;
}

function asTitle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlPlaneValidationError("title is required");
  }
  if (value.length > MAX_TITLE_LENGTH) {
    throw new ControlPlaneValidationError(`title must be <= ${MAX_TITLE_LENGTH} characters`);
  }
  return value;
}

function asLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_LABEL.test(value)) {
    throw new ControlPlaneValidationError(`${field} must be a short safe label`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlPlaneValidationError(`${field} is required`);
  }
  return value;
}

function asOptionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ControlPlaneValidationError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneValidationError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function writeRecord(file: string, record: ControlPlaneRoom): Promise<void> {
  await ensureSecureDir(path.dirname(file));
  await writeSecureFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file, "utf8");
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
