// Host tunnel client.
//
// Connects a host to a local tunnel broker over HTTP, registers a route for a
// room slug, and records the resulting public base URL on disk so the running
// room server and the CLI can advertise it. The host tunnel session is kept
// distinct from participant tokens: the broker-minted host_connection_id is a
// routing credential, never a participant bearer token.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ensureSecureDir, writeSecureFile } from "../storage/index.js";
import { normalizeBaseUrl, roomUrl } from "../protocol/index.js";
import { relayToLocalServer } from "./forwarding.js";
import {
  type ForwardedRequest,
  type ForwardedResponse,
  type RouteCloseResult,
  type RouteMetadata,
  TunnelError,
  type TunnelErrorBody,
  type TunnelErrorCode
} from "./protocol.js";

const RELAY_RESPONSE_BODY_BYTES = 1024 * 1024;

export interface RegisterResult {
  route: RouteMetadata;
  publicBaseUrl: string;
}

/** HTTP client for a local tunnel broker's host control endpoints. */
export class TunnelClient {
  private readonly brokerBaseUrl: string;

  constructor(brokerBaseUrl: string) {
    this.brokerBaseUrl = normalizeBaseUrl(brokerBaseUrl);
  }

  /** Register a route for a slug and compute its public base URL. */
  async register(slug: string, target?: string): Promise<RegisterResult> {
    const payload = await this.post("/_host/register", {
      route_slug: slug,
      ...(target === undefined ? {} : { target })
    });
    const route = payload.route as RouteMetadata;
    return { route, publicBaseUrl: this.publicBaseUrlFor(route.route_slug) };
  }

  /** Refresh a route to keep the host session alive. */
  async heartbeat(routeId: string, hostConnectionId: string): Promise<RouteMetadata> {
    const payload = await this.post("/_host/heartbeat", {
      route_id: routeId,
      host_connection_id: hostConnectionId
    });
    return payload.route as RouteMetadata;
  }

  /** Close a route the host owns. */
  async close(routeId: string, hostConnectionId: string): Promise<RouteCloseResult> {
    const payload = await this.post("/_host/close", {
      route_id: routeId,
      host_connection_id: hostConnectionId
    });
    return payload as unknown as RouteCloseResult;
  }

  /** Claim the next pending relay request for the route, or null if none. */
  async poll(routeId: string, hostConnectionId: string): Promise<ForwardedRequest | null> {
    const payload = await this.post("/_host/poll", { route_id: routeId, host_connection_id: hostConnectionId });
    return (payload.request as ForwardedRequest | null) ?? null;
  }

  /** Post the response for exactly one in-flight relay request id. */
  async respond(
    routeId: string,
    hostConnectionId: string,
    requestId: string,
    response: ForwardedResponse
  ): Promise<void> {
    await this.post("/_host/respond", {
      route_id: routeId,
      host_connection_id: hostConnectionId,
      request_id: requestId,
      response
    });
  }

  /**
   * Attend the route once: claim a pending request, forward it to the local
   * room server, and post the response back. Returns true if a request was
   * handled, false if none were pending. This is the host outbound relay step;
   * the broker never reaches the local server itself.
   */
  async attendOnce(routeId: string, hostConnectionId: string, target: string): Promise<boolean> {
    const request = await this.poll(routeId, hostConnectionId);
    if (request === null) return false;
    await this.handleClaim(routeId, hostConnectionId, request, target);
    return true;
  }

  /**
   * Forward an already-claimed request to the local room server and post the
   * response. Failures become a stable error response so the participant never
   * hangs. Used by the foreground run loop to process claims concurrently.
   */
  async handleClaim(
    routeId: string,
    hostConnectionId: string,
    request: ForwardedRequest,
    target: string
  ): Promise<void> {
    let response: ForwardedResponse;
    try {
      response = await relayToLocalServer(target, request, RELAY_RESPONSE_BODY_BYTES);
    } catch (error) {
      response = {
        status: error instanceof TunnelError ? error.status : 502,
        headers: { "content-type": "application/json; charset=utf-8" },
        body_base64: Buffer.from(
          JSON.stringify({ ok: false, error: error instanceof TunnelError ? error.code : "host_unavailable" })
        ).toString("base64")
      };
    }
    await this.respond(routeId, hostConnectionId, request.request_id, response);
  }

  publicBaseUrlFor(slug: string): string {
    return normalizeBaseUrl(roomUrl(this.brokerBaseUrl, slug));
  }

  private async post(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(new URL(action, `${this.brokerBaseUrl}/`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      // A failed fetch is a transport problem, not proof the route is gone.
      // Mapping it to route_not_found previously made a single transient blip
      // tear down a live tunnel; broker_unreachable is retried by the session.
      throw new TunnelError("broker_unreachable", 502, "could not reach the tunnel broker");
    }
    const payload = await readJson(response);
    if (!response.ok || payload.ok === false) {
      const error = payload as Partial<TunnelErrorBody>;
      throw new TunnelError(
        (error.error as TunnelErrorCode) ?? "internal_error",
        response.status,
        typeof error.message === "string" ? error.message : "tunnel broker rejected the request"
      );
    }
    return payload;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Host-side record of an active tunnel session for a room. */
export interface HostTunnelState {
  public_base_url: string;
  route_slug: string;
  route_id: string;
  host_connection_id: string;
  broker_url: string;
  target_url: string;
  registered_at: string;
}

export function tunnelStatePath(home: string, roomId: string): string {
  return path.join(home, "rooms", roomId, "tunnel.json");
}

export async function writeHostTunnelState(
  home: string,
  roomId: string,
  state: HostTunnelState
): Promise<void> {
  const file = tunnelStatePath(home, roomId);
  await ensureSecureDir(path.dirname(file));
  await writeSecureFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Read the published public base URL for a room, or undefined if no tunnel has
 * been started. Synchronous so the room server can resolve it per request.
 */
export function readPublicBaseUrl(home: string, roomId: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(tunnelStatePath(home, roomId), "utf8")) as Partial<HostTunnelState>;
    return typeof state.public_base_url === "string" ? state.public_base_url : undefined;
  } catch {
    return undefined;
  }
}
