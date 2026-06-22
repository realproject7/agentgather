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
import {
  type RouteCloseResult,
  type RouteMetadata,
  TunnelError,
  type TunnelErrorBody,
  type TunnelErrorCode
} from "./protocol.js";

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
      throw new TunnelError("route_not_found", 502, "could not reach the tunnel broker");
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
