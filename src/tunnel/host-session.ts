// Foreground host tunnel session.
//
// Keeps a local room attached to the managed broker: a heartbeat loop holds the
// route, and a single poll loop claims relay requests and dispatches them to a
// bounded number of concurrent handlers. Bounded concurrency matters because a
// claimed `/wait` can hold for ~25s; a serial loop would starve normal card,
// message, and asset requests behind it.

import type { TunnelClient } from "./client.js";
import { type ForwardedRequest, TunnelError } from "./protocol.js";

export interface HostTunnelSessionOptions {
  routeId: string;
  hostConnectionId: string;
  target: string;
  /** Maximum requests processed concurrently. Must be > 1 to avoid starving. */
  concurrency?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  /** Called once when the heartbeat or a poll fails fatally (route/broker gone). */
  onError?: (error: unknown) => void;
}

const DEFAULT_CONCURRENCY = 16;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

// A poll failure with one of these codes means the route is gone for good.
const FATAL_POLL_CODES = new Set(["route_closed", "route_expired", "route_not_found"]);

export class HostTunnelSession {
  private readonly client: TunnelClient;
  private readonly routeId: string;
  private readonly hostConnectionId: string;
  private readonly target: string;
  private readonly concurrency: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;

  private readonly controller = new AbortController();
  private readonly handlers = new Set<Promise<void>>();
  private heartbeatTimer?: NodeJS.Timeout;
  private pollLoop?: Promise<void>;
  private stopped = false;
  private failureError: unknown;

  constructor(client: TunnelClient, options: HostTunnelSessionOptions) {
    this.client = client;
    this.routeId = options.routeId;
    this.hostConnectionId = options.hostConnectionId;
    this.target = options.target;
    this.concurrency = Math.max(2, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onError = options.onError;
  }

  /** The first fatal error that shut the session down, if any. */
  get failure(): unknown {
    return this.failureError;
  }

  start(): void {
    this.heartbeatTimer = setInterval(() => void this.beat(), this.heartbeatIntervalMs);
    this.pollLoop = this.runPollLoop();
  }

  async stop(options: { closeRoute?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.pollLoop !== undefined) await this.pollLoop;
    await Promise.allSettled([...this.handlers]);
    if (options.closeRoute === true) {
      try {
        await this.client.close(this.routeId, this.hostConnectionId);
      } catch {
        // Best effort: the route may already be closed or expired.
      }
    }
  }

  private async runPollLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      if (this.handlers.size >= this.concurrency) {
        await this.idle(this.pollIntervalMs);
        continue;
      }
      let request: ForwardedRequest | null;
      try {
        request = await this.client.poll(this.routeId, this.hostConnectionId);
      } catch (error) {
        if (error instanceof TunnelError && FATAL_POLL_CODES.has(error.code)) {
          this.fail(error);
          return;
        }
        await this.idle(this.pollIntervalMs);
        continue;
      }
      if (request === null) {
        await this.idle(this.pollIntervalMs);
        continue;
      }
      const handler = this.handle(request);
      this.handlers.add(handler);
      void handler.finally(() => this.handlers.delete(handler));
    }
  }

  private async handle(request: ForwardedRequest): Promise<void> {
    try {
      await this.client.handleClaim(this.routeId, this.hostConnectionId, request, this.target);
    } catch {
      // The request may have already settled (closed/timed out); nothing to do.
    }
  }

  private async beat(): Promise<void> {
    if (this.controller.signal.aborted) return;
    try {
      await this.client.heartbeat(this.routeId, this.hostConnectionId);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.failureError === undefined) this.failureError = error;
    this.controller.abort();
    this.onError?.(error);
  }

  private idle(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const signal = this.controller.signal;
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
