import { spawn } from "node:child_process";
import { flagBoolean, flagString, parseArgs } from "../../args.js";
import type { CliContext } from "../../context.js";
import { readCurrent, type CurrentRoom } from "../../state.js";
import { roomUrl, type Message } from "../../../protocol/index.js";
import { currentSinceId, parseSinceId, waitOnce } from "../message/transport.js";

// Opt-in local wake adapter (V2.1 C, #187). Holds the cheap /wait long-poll and,
// ONLY on an actionable event, invokes a host-configured command once (drain-on-run):
// the command reads the room through the API itself using the AG_ROOM_URL/AG_SINCE_ID
// pointers — room MESSAGE CONTENT never reaches its argv or env, and it is spawned
// with no shell, so room text can never be interpolated (the #20 invariant). Empty
// polls and heartbeats only advance the durable cursor. This is what makes an agent
// honestly Tier A (#185) without a GUI app, embedded SDK, or credential reuse.

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
// Room-log signals that justify one invocation. A mention of my alias, or the T11
// active-session-start system line. Forum-review assignments reach the adapter as an
// @mention of the reviewer, so they are covered by the mention case.
const ACTIVE_SESSION_STARTED = /active chat session started/i;

export interface WakeAdapterOptions {
  // Injectable for tests: run the command with the given env, resolve its exit code.
  runCommand?: (command: string, env: NodeJS.ProcessEnv) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
}

export async function runWakeAdapterCommand(
  argv: string[],
  context: CliContext,
  options: WakeAdapterOptions = {}
): Promise<number> {
  const args = parseArgs(argv);
  const command = flagString(args, "exec");
  if (command === undefined || command.trim() === "") {
    context.stderr.write("wake-adapter requires --exec <command> (opt-in; there is no default command)\n");
    return 1;
  }
  const json = flagBoolean(args, "json");
  const maxEvents = optionalCount(flagString(args, "max-events"));
  const maxTurns = optionalCount(flagString(args, "max-turns"));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const current = await readCurrent(context.home);
  // Declare wake_on_event so the roster/tier (#185) reads Tier A honestly. Best-effort:
  // a join failure must not stop the watcher — the token still authorizes /wait.
  await declareWakeOnEvent(current).catch(() => undefined);

  let sinceId = await currentSinceId(context, flagString(args, "since"));
  let turns = 0;
  let events = 0;
  let backoffMs = BACKOFF_BASE_MS;

  while ((maxTurns === undefined || turns < maxTurns) && (maxEvents === undefined || events < maxEvents)) {
    let response;
    try {
      response = await waitOnce(context, sinceId);
    } catch (error) {
      // Bounded restart backoff: a transient /wait failure must not hot-loop.
      context.stderr.write(
        `wake-adapter: /wait failed (${error instanceof Error ? error.message : String(error)}); retrying in ${backoffMs}ms\n`
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      continue;
    }
    turns += 1;
    backoffMs = BACKOFF_BASE_MS;
    const previousSinceId = sinceId;
    // waitOnce persists the cursor durably (survives restart → no duplicate delivery).
    sinceId = response.next_since_id;

    const actionable = isActionable(response.messages, current.alias);
    if (json) {
      context.stdout.write(
        `${JSON.stringify({ ok: true, turn: turns, next_since_id: sinceId, actionable, room_status: response.room_status })}\n`
      );
    }

    // A closed room ends the watcher — there is nothing left to wake for.
    if (response.room_status === "closed") break;

    if (actionable) {
      events += 1;
      // Pointer-only env: AG_SINCE_ID is the cursor BEFORE this batch so the invoked
      // agent can read exactly the new messages via the API. No message content here.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AG_ROOM_URL: current.baseUrl,
        AG_SINCE_ID: String(previousSinceId)
      };
      const code = await runCommand(command, env);
      if (code !== 0) {
        context.stderr.write(`wake-adapter: command exited ${code}; backing off ${backoffMs}ms\n`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }
  return 0;
}

// Actionable = a mention of my alias, or the active-session-start system line.
function isActionable(messages: Message[], alias: string): boolean {
  return messages.some(
    (message) =>
      (Array.isArray(message.mentions) && message.mentions.includes(alias)) ||
      (message.type === "system" && ACTIVE_SESSION_STARTED.test(message.text))
  );
}

function optionalCount(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : parseSinceId(raw);
}

async function declareWakeOnEvent(current: CurrentRoom): Promise<void> {
  await fetch(roomUrl(current.baseUrl, "/join"), {
    method: "POST",
    headers: { Authorization: `Bearer ${current.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ supported_modes: ["wake_on_event", "manual"] })
  });
}

// Spawn the host-configured command with NO args and shell:false so room content can
// never be interpolated into a shell or injected as an argument. The command reads
// the room itself via the API using the AG_ROOM_URL/AG_SINCE_ID env pointers.
function defaultRunCommand(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { env, stdio: "inherit", shell: false });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
