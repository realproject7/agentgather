// Public-routing free-quota metering.
//
// Cumulative usage accounting for public routing, distinct from the
// instantaneous abuse throttles in src/tunnel/limits.ts. Metering observes
// public-route lifecycle events and tallies them per subject over a daily reset
// window; it never inspects or stores message content. Local-only rooms are not
// metered. Exceeding the free quota surfaces a stable quota_exceeded signal that
// #85/#86 consume — this ticket makes no payment decisions.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureSecureDir, withWriterLock, writeSecureFile } from "../storage/index.js";
import { TunnelError, type BrokerMeter } from "../tunnel/index.js";

export const METERED_DIMENSIONS = [
  "route_minutes",
  "active_public_rooms",
  "participant_joins",
  "relay_requests",
  "bandwidth_bytes"
] as const;

export type MeteredDimension = (typeof METERED_DIMENSIONS)[number];

export type Counters = Record<MeteredDimension, number>;

/** Per-dimension free allowance for a single quota window. */
export type FreeQuota = Counters;

export interface MeteringWindow {
  window_id: string;
  started_at: string;
  counters: Counters;
}

export interface MeteringRecord {
  // Owner/user id stand-in for the future account layer, or a route slug. Opaque
  // metering key only; it authenticates nothing.
  subject: string;
  window: MeteringWindow;
  exceeded: boolean;
  exceeded_reasons: MeteredDimension[];
  updated_at: string;
}

export interface QuotaSignal {
  exceeded: boolean;
  reasons: MeteredDimension[];
}

const DAY_MS = 24 * 60 * 60_000;

// Permissive defaults so local development is never blocked by the quota; tests
// configure tighter values to exercise exceeded behaviour.
export const DEFAULT_FREE_QUOTA: FreeQuota = {
  route_minutes: 6_000,
  active_public_rooms: 100,
  participant_joins: 10_000,
  relay_requests: 1_000_000,
  bandwidth_bytes: 50 * 1024 * 1024 * 1024
};

const SUBJECT_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/** Pluggable persistence for metering records, so tests can inject a fake. */
export interface MeteringStore {
  read(subject: string): Promise<MeteringRecord | null>;
  write(subject: string, record: MeteringRecord): Promise<void>;
}

/** File-backed metering store under <root>/platform/metering, reusing #80 patterns. */
export function fileMeteringStore(root: string): MeteringStore {
  const dir = path.join(root, "platform", "metering");
  const fileFor = (subject: string): string => path.join(dir, `${assertSubject(subject)}.json`);
  return {
    async read(subject) {
      try {
        return JSON.parse(await readFile(fileFor(subject), "utf8")) as MeteringRecord;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async write(subject, record) {
      await ensureSecureDir(dir);
      await withWriterLock(path.join(dir, ".lock"), async () => {
        await writeSecureFile(fileFor(subject), `${JSON.stringify(record, null, 2)}\n`);
      });
    }
  };
}

export interface MeteringLedgerOptions {
  store: MeteringStore;
  now?: () => number;
  quota?: Partial<FreeQuota>;
  windowMs?: number;
}

export interface RecordOptions {
  /** Public routing is metered; local-only routes pass false and are skipped. */
  isPublicRoute?: boolean;
}

/**
 * Cumulative free-quota ledger for public routing. Reads, increments, and
 * persists per-subject counters in the current window, rolling the window over
 * when the clock crosses a window boundary.
 */
export class MeteringLedger {
  private readonly store: MeteringStore;
  private readonly now: () => number;
  private readonly quota: FreeQuota;
  private readonly windowMs: number;

  constructor(options: MeteringLedgerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.quota = { ...DEFAULT_FREE_QUOTA, ...options.quota };
    this.windowMs = options.windowMs ?? DAY_MS;
  }

  /**
   * Record usage on a dimension for a public route. Returns the updated record,
   * or null when the call is for a local-only route (not metered).
   */
  async record(
    subject: string,
    dimension: MeteredDimension,
    amount = 1,
    options: RecordOptions = {}
  ): Promise<MeteringRecord | null> {
    if (options.isPublicRoute === false) return null;
    assertSubject(subject);
    if (!METERED_DIMENSIONS.includes(dimension)) {
      throw new Error(`unknown metered dimension: ${dimension}`);
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("metering amount must be a non-negative number");
    }
    const existing = await this.store.read(subject);
    const window = this.windowFor(existing);
    window.counters[dimension] += amount;
    const record = this.finalize(subject, window);
    await this.store.write(subject, record);
    return record;
  }

  /** Current usage snapshot for a subject, rolling the window if it has reset. */
  async usage(subject: string): Promise<MeteringRecord> {
    assertSubject(subject);
    const existing = await this.store.read(subject);
    return this.finalize(subject, this.windowFor(existing));
  }

  /** Quota-exceeded signal for a subject without recording usage. */
  async check(subject: string): Promise<QuotaSignal> {
    const record = await this.usage(subject);
    return { exceeded: record.exceeded, reasons: record.exceeded_reasons };
  }

  /**
   * Enforcement hook for public-route admit paths. Throws a stable
   * quota_exceeded TunnelError when the subject is over quota. Local-only routes
   * pass isPublicRoute:false and are always admitted (permissive for local dev).
   */
  async assertWithinQuota(subject: string, options: RecordOptions = {}): Promise<void> {
    if (options.isPublicRoute === false) return;
    const signal = await this.check(subject);
    if (signal.exceeded) {
      throw new TunnelError(
        "quota_exceeded",
        429,
        `public routing free quota exceeded for the current window: ${signal.reasons.join(", ")}`
      );
    }
  }

  private windowFor(existing: MeteringRecord | null): MeteringWindow {
    const nowMs = this.now();
    const windowId = String(Math.floor(nowMs / this.windowMs));
    if (existing !== null && existing.window.window_id === windowId) {
      return { ...existing.window, counters: { ...zeroCounters(), ...existing.window.counters } };
    }
    return { window_id: windowId, started_at: new Date(nowMs).toISOString(), counters: zeroCounters() };
  }

  private finalize(subject: string, window: MeteringWindow): MeteringRecord {
    const reasons = METERED_DIMENSIONS.filter((dimension) => window.counters[dimension] > this.quota[dimension]);
    return {
      subject,
      window,
      exceeded: reasons.length > 0,
      exceeded_reasons: reasons,
      updated_at: new Date(this.now()).toISOString()
    };
  }
}

export interface BrokerMeterOptions {
  /** Map a public route slug to its metering subject (owner stand-in). */
  subjectForSlug?: (slug: string) => string;
}

/**
 * Adapt a MeteringLedger to the broker's BrokerMeter hook so the broker's public
 * relay lifecycle and admit/forward paths record real usage. This is the
 * dependency-inversion seam: the broker defines BrokerMeter, this maps it onto
 * the ledger, and the composition root injects the result into the broker.
 */
export function createBrokerMeter(ledger: MeteringLedger, options: BrokerMeterOptions = {}): BrokerMeter {
  const subjectFor = options.subjectForSlug ?? ((slug: string) => slug);
  return {
    onPublicRouteRegistered: async (slug) => {
      await ledger.record(subjectFor(slug), "active_public_rooms", 1, { isPublicRoute: true });
    },
    onPublicRouteClosed: async (slug, durationMs) => {
      await ledger.record(subjectFor(slug), "route_minutes", Math.max(0, Math.round(durationMs / 60_000)), {
        isPublicRoute: true
      });
    },
    admitPublicForward: (slug) => ledger.assertWithinQuota(subjectFor(slug), { isPublicRoute: true }),
    onPublicForward: async (slug, forwardPath, bytesIn, bytesOut) => {
      const subject = subjectFor(slug);
      await ledger.record(subject, "relay_requests", 1, { isPublicRoute: true });
      await ledger.record(subject, "bandwidth_bytes", bytesIn + bytesOut, { isPublicRoute: true });
      if (forwardPath === "/join" || forwardPath.startsWith("/join?")) {
        await ledger.record(subject, "participant_joins", 1, { isPublicRoute: true });
      }
    }
  };
}

function zeroCounters(): Counters {
  return {
    route_minutes: 0,
    active_public_rooms: 0,
    participant_joins: 0,
    relay_requests: 0,
    bandwidth_bytes: 0
  };
}

function assertSubject(subject: string): string {
  if (typeof subject !== "string" || !SUBJECT_PATTERN.test(subject)) {
    throw new Error("metering subject must be 1-128 chars of [A-Za-z0-9_-]");
  }
  return subject;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
