import type { ClientMessageInput, Message, MessageType } from "./types.js";

export const MAX_MESSAGE_TEXT_LENGTH = 24_000;
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;

export interface BuildMessageOptions {
  id: number;
  room: string;
  from: string;
  now: Date;
  mentions: string[];
  type?: MessageType;
}

export function clientMessageInputFromRecord(record: unknown): ClientMessageInput {
  if (record === null || typeof record !== "object") {
    throw new Error("message input must be an object");
  }

  const source = record as Record<string, unknown>;
  if (typeof source.text !== "string" || source.text.trim().length === 0) {
    throw new Error("message text is required");
  }
  if (source.text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new Error(`message text must be <= ${MAX_MESSAGE_TEXT_LENGTH} characters`);
  }

  const input: ClientMessageInput = { text: source.text };
  if (source.reply_to !== undefined) {
    input.reply_to = parsePositiveMessageId(source.reply_to, "reply_to");
  }
  if (source.client_msg_id !== undefined) {
    input.client_msg_id = parseClientMessageId(source.client_msg_id);
  }
  return input;
}

export function buildMessage(input: ClientMessageInput, options: BuildMessageOptions): Message {
  const message: Message = {
    id: options.id,
    room: options.room,
    ts: options.now.toISOString(),
    from: options.from,
    type: options.type ?? "message",
    text: input.text,
    mentions: options.mentions
  };
  if (input.reply_to !== undefined) {
    message.reply_to = input.reply_to;
  }
  if (input.client_msg_id !== undefined) {
    message.client_msg_id = input.client_msg_id;
  }
  return message;
}

function parsePositiveMessageId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function parseClientMessageId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CLIENT_MESSAGE_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error(
      `client_msg_id must be 1-${MAX_CLIENT_MESSAGE_ID_LENGTH} chars using letters, numbers, dot, underscore, colon, or dash`
    );
  }
  return value;
}
