import {
  appendMessageResult,
  readCursor,
  readMessages,
  writeCursor
} from "../../../storage/index.js";
import type { ClientMessageInput, Message, WaitResponse } from "../../../protocol/index.js";
import { roomUrl } from "../../../protocol/index.js";
import type { CliContext } from "../../context.js";
import { readCurrent, type CurrentRoom } from "../../state.js";

export interface MessageListResult {
  ok: true;
  messages: Message[];
  next_since_id: number;
  next_cmd: string;
}

export interface SendMessageResult {
  ok: true;
  message: Message;
  idempotent?: boolean;
}

export async function currentSinceId(context: CliContext, rawSince: string | undefined): Promise<number> {
  if (rawSince !== undefined) return parseSinceId(rawSince);
  const current = await readCurrent(context.home);
  return readCursor(context.home, current.roomId, current.alias);
}

export async function sendMessage(context: CliContext, input: ClientMessageInput): Promise<SendMessageResult> {
  const current = await readCurrent(context.home);
  const sent = await requestJson<SendMessageResult>(current, "/messages", "POST", input);
  if (sent !== null) return sent;

  const result = await appendMessageResult({
    root: context.home,
    roomId: current.roomId,
    from: current.alias,
    input
  });
  return {
    ok: true,
    message: result.message,
    ...(result.idempotent ? { idempotent: true } : {})
  };
}

export async function listMessages(context: CliContext, sinceId: number): Promise<MessageListResult> {
  const current = await readCurrent(context.home);
  const path = `/messages?since_id=${sinceId}`;
  const remote = await requestJson<MessageListResult>(current, path, "GET");
  if (remote !== null) {
    return {
      ...remote,
      next_cmd: `agentgather messages --since ${remote.next_since_id} --json`
    };
  }

  const messages = (await readMessages(context.home, current.roomId)).filter((message) => message.id > sinceId);
  return {
    ok: true,
    messages,
    next_since_id: messages.at(-1)?.id ?? sinceId,
    next_cmd: `agentgather messages --since ${messages.at(-1)?.id ?? sinceId} --json`
  };
}

export async function readAndStoreCursor(context: CliContext, sinceId: number): Promise<MessageListResult> {
  const current = await readCurrent(context.home);
  const result = await listMessages(context, sinceId);
  await writeCursor(context.home, current.roomId, current.alias, result.next_since_id);
  return {
    ...result,
    next_cmd: `agentgather read --since ${result.next_since_id} --json`
  };
}

export async function waitOnce(context: CliContext, sinceId: number): Promise<WaitResponse & { cli_next_cmd: string | null }> {
  const current = await readCurrent(context.home);
  const path = `/wait?participant=${current.alias}&since_id=${sinceId}`;
  // attend/watch long-poll the host room server over HTTP GET /wait. Surface a
  // precise reason (not the old "/watch" wording) and never print the token.
  let response: Response;
  try {
    response = await fetch(roomUrl(current.baseUrl, path), {
      method: "GET",
      headers: { Authorization: `Bearer ${current.token}`, "Content-Type": "application/json" }
    });
  } catch {
    throw new Error(
      `could not reach the room server at ${current.baseUrl} for HTTP /wait. ` +
        "Check that `agentgather room serve` is running, the current baseUrl (`agentgather room current`), and tunnel state."
    );
  }
  if (response.status === 404) {
    throw new Error(
      `HTTP /wait returned 404 at ${current.baseUrl}. The route or baseUrl may not point at a running room server ` +
        "(route/server mismatch, not a missing /watch endpoint)."
    );
  }
  const payload = await readResponseJson<WaitResponse & { message?: string }>(response);
  if (!response.ok) {
    throw new Error(payload.message ?? `HTTP /wait failed with HTTP ${response.status}`);
  }
  const waitResponse = payload as WaitResponse;
  await writeCursor(context.home, current.roomId, current.alias, waitResponse.next_since_id);
  return {
    // Continuous attendance points back to `agentgather attend`; `watch` is a
    // one-turn alias, so it should not instruct agents to loop via watch.
    ...waitResponse,
    cli_next_cmd: waitResponse.keep_waiting ? `agentgather attend --since ${waitResponse.next_since_id} --json` : null
  };
}

export function formatMessages(messages: Message[]): string {
  if (messages.length === 0) return "(no messages)\n";
  return messages.map((message) => `${message.id} ${message.ts} ${message.from}: ${message.text}`).join("\n") + "\n";
}

export function parseSinceId(raw: string): number {
  const sinceId = Number(raw);
  if (!Number.isSafeInteger(sinceId) || sinceId < 0) {
    throw new Error("since must be a non-negative safe integer");
  }
  return sinceId;
}

async function requestJson<T>(
  current: CurrentRoom,
  path: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<T | null> {
  try {
    const response = await fetch(roomUrl(current.baseUrl, path), {
      method,
      headers: {
        Authorization: `Bearer ${current.token}`,
        "Content-Type": "application/json"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await readResponseJson<T & { message?: string }>(response);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(payload.message ?? `request failed with HTTP ${response.status}`);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function readResponseJson<T>(response: Response): Promise<Partial<T>> {
  try {
    return JSON.parse(await response.text()) as Partial<T>;
  } catch {
    return {};
  }
}
