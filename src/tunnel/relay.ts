// Host-connected relay queue.
//
// In managed mode the broker cannot reach the host's private room server. A
// participant request becomes a bounded in-flight forwarded request: the broker
// holds it in memory, the host tunnel client claims it over an outbound poll,
// forwards it to its local room server, and posts the response back. Bodies live
// only in memory while in flight and are never persisted or logged here.

import type { ForwardedRequest, ForwardedResponse } from "./protocol.js";
import { TunnelError } from "./protocol.js";

export interface RelayOptions {
  /** Max time a request waits unclaimed before the host is deemed unavailable. */
  claimTimeoutMs: number;
  /** Max time after a claim before the host response is deemed timed out. */
  responseTimeoutMs: number;
  /** Cap on a posted response body. */
  responseBodyBytes: number;
}

interface InFlight {
  envelope: ForwardedRequest;
  slug: string;
  resolve: (response: ForwardedResponse) => void;
  reject: (error: TunnelError) => void;
  claimed: boolean;
  timer: NodeJS.Timeout;
}

/**
 * Tracks in-flight participant requests waiting for a host relay response. One
 * hub serves all routes; requests are keyed by a broker-minted request id.
 */
export class RelayHub {
  private readonly options: RelayOptions;
  private readonly mintId: () => string;
  private readonly pending = new Map<string, string[]>();
  private readonly inflight = new Map<string, InFlight>();

  constructor(options: RelayOptions, mintId: () => string) {
    this.options = options;
    this.mintId = mintId;
  }

  /** Enqueue a participant request and resolve once the host responds. */
  enqueue(slug: string, envelope: Omit<ForwardedRequest, "request_id">): Promise<ForwardedResponse> {
    const requestId = this.mintId();
    const full: ForwardedRequest = { ...envelope, request_id: requestId };
    return new Promise<ForwardedResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(requestId, new TunnelError("host_unavailable", 504, "host tunnel did not attend the request"));
      }, this.options.claimTimeoutMs);
      timer.unref();
      this.inflight.set(requestId, { envelope: full, slug, resolve, reject, claimed: false, timer });
      const queue = this.pending.get(slug) ?? [];
      queue.push(requestId);
      this.pending.set(slug, queue);
    });
  }

  /** Host claims the next pending request for a route, or null if none. */
  claim(slug: string): ForwardedRequest | null {
    const queue = this.pending.get(slug);
    while (queue !== undefined && queue.length > 0) {
      const requestId = queue.shift();
      if (requestId === undefined) break;
      const item = this.inflight.get(requestId);
      if (item === undefined || item.claimed) continue;
      item.claimed = true;
      clearTimeout(item.timer);
      item.timer = setTimeout(() => {
        this.fail(requestId, new TunnelError("host_unavailable", 504, "host tunnel did not respond in time"));
      }, this.options.responseTimeoutMs);
      item.timer.unref();
      if (queue.length === 0) this.pending.delete(slug);
      return item.envelope;
    }
    if (queue !== undefined && queue.length === 0) this.pending.delete(slug);
    return null;
  }

  /** Host posts the response for exactly one in-flight request id. */
  respond(requestId: string, response: ForwardedResponse): void {
    const item = this.inflight.get(requestId);
    if (item === undefined) {
      throw new TunnelError("unknown_request", 404, "no in-flight request for this id");
    }
    const bodyBytes = typeof response.body_base64 === "string" ? Buffer.byteLength(response.body_base64, "base64") : 0;
    if (bodyBytes > this.options.responseBodyBytes) {
      this.fail(requestId, new TunnelError("response_too_large", 502, "forwarded response exceeds the broker limit"));
      throw new TunnelError("response_too_large", 502, "forwarded response exceeds the broker limit");
    }
    clearTimeout(item.timer);
    this.remove(requestId);
    item.resolve(response);
  }

  /** Reject every in-flight request for a closed route. */
  closeRoute(slug: string): void {
    for (const [requestId, item] of [...this.inflight]) {
      if (item.slug === slug) {
        this.fail(requestId, new TunnelError("route_closed", 410, "this route has been closed"));
      }
    }
  }

  private fail(requestId: string, error: TunnelError): void {
    const item = this.inflight.get(requestId);
    if (item === undefined) return;
    clearTimeout(item.timer);
    this.remove(requestId);
    item.reject(error);
  }

  private remove(requestId: string): void {
    const item = this.inflight.get(requestId);
    this.inflight.delete(requestId);
    if (item === undefined) return;
    const queue = this.pending.get(item.slug);
    if (queue === undefined) return;
    const index = queue.indexOf(requestId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(item.slug);
  }
}
