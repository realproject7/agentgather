import type { ClientMessageInput } from "../../../protocol/index.js";
import { flagBoolean, flagString, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import {
  currentSinceId,
  formatMessages,
  listMessages,
  parseSinceId,
  readAndStoreCursor,
  sendMessage
} from "./transport.js";

export async function runSendCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const target = args.positional[0];
  const text = flagString(args, "text") ?? args.positional.slice(1).join(" ");
  if (target === undefined || text.length === 0) {
    throw new Error("send requires <alias> and message text");
  }
  const clientMsgId = flagString(args, "client-msg-id");
  const input: ClientMessageInput = {
    text: `@${target} ${text}`,
    ...(clientMsgId === undefined ? {} : { client_msg_id: clientMsgId })
  };
  const result = await sendMessage(context, input);
  return emit(context, flagBoolean(args, "json"), result, `sent #${result.message.id} to @${target}\n`);
}

export async function runReplyCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const replyTo = args.positional[0] === undefined ? undefined : parseSinceId(args.positional[0]);
  const text = flagString(args, "text") ?? args.positional.slice(1).join(" ");
  if (replyTo === undefined || text.length === 0) {
    throw new Error("reply requires <message_id> and message text");
  }
  const clientMsgId = flagString(args, "client-msg-id");
  const input: ClientMessageInput = {
    type: "reply",
    text,
    reply_to: replyTo,
    ...(clientMsgId === undefined ? {} : { client_msg_id: clientMsgId })
  };
  const result = await sendMessage(context, input);
  return emit(context, flagBoolean(args, "json"), result, `replied #${result.message.id} to #${replyTo}\n`);
}

export async function runMessagesCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const sinceId = await currentSinceId(context, flagString(args, "since"));
  const result = await listMessages(context, sinceId);
  return emit(context, flagBoolean(args, "json"), result, formatMessages(result.messages));
}

export async function runReadCommand(argv: string[], context: CliContext): Promise<number> {
  const args = parseArgs(argv);
  const sinceId = await currentSinceId(context, flagString(args, "since"));
  const result = await readAndStoreCursor(context, sinceId);
  return emit(context, flagBoolean(args, "json"), result, formatMessages(result.messages));
}

function emit(context: CliContext, json: boolean, value: unknown, text: string): number {
  context.stdout.write(json ? `${JSON.stringify(value)}\n` : text);
  return 0;
}
