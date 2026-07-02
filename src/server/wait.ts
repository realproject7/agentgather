import { roomUrl, type Message, type WaitResponse } from "../protocol/index.js";

export interface BuildWaitResponseOptions {
  room: string;
  roomStatus: "open" | "closed";
  participant: string;
  messages: Message[];
  sinceId: number;
  baseUrl: string;
  heartbeat: boolean;
  keepWaiting: boolean;
}

export class WaitHub {
  private readonly waiters = new Map<string, Set<() => void>>();

  wait(roomId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(roomId) ?? new Set<() => void>();
      this.waiters.set(roomId, waiters);
      const done = (): void => {
        signal.removeEventListener("abort", done);
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(roomId);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  notify(roomId: string): void {
    const waiters = this.waiters.get(roomId);
    if (waiters === undefined) return;
    for (const done of [...waiters]) done();
  }
}

export const defaultWaitHub = new WaitHub();

export function buildWaitResponse(options: BuildWaitResponseOptions): WaitResponse {
  const nextSinceId = options.messages.at(-1)?.id ?? options.sinceId;
  return {
    ok: true,
    room: options.room,
    room_status: options.roomStatus,
    participant: options.participant,
    heartbeat: options.heartbeat,
    messages: options.messages,
    mentioned: options.messages.some((message) => message.mentions.includes(options.participant)),
    next_since_id: nextSinceId,
    keep_waiting: options.keepWaiting,
    // #75: a delivered-message response (keep_waiting=false while the room is OPEN)
    // must still carry an actionable, cursor-updated continuation so the caller can
    // resume the /wait long-poll from next_since_id instead of dead-ending. next_cmd
    // is null only when the room is closed — there is nothing left to continue.
    next_cmd:
      options.roomStatus === "open"
        ? `curl -s "${roomUrl(options.baseUrl, `/wait?participant=${options.participant}&since_id=${nextSinceId}`)}" -H "Authorization: Bearer $TOKEN"`
        : null
  };
}
