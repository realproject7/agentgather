// Host-runtime launch handoff (#143 / T7A).
//
// A boardroom is only live while its host runtime (`room serve`) runs. Holding
// that server in an agent's foreground task is a poor default, so this module
// builds a launch *plan*: when a detachable runner (tmux) is available it
// produces a detached `room serve` command (+ stop/status); otherwise it hands a
// copy-pastable command block to a human operator. It also classifies runtime
// state for status surfaces.
//
// This is deliberately smaller than managed/core supervision: no durable
// supervision, no remote wake, no managed lifecycle. The plan is pure and
// carries NO participant tokens or invite URLs — only host, port, public URL,
// log path, and a session name.

export type RuntimeState = "runtime-running" | "runtime-unreachable" | "manual-run-required";
export type RuntimeStrategy = "detached-tmux" | "manual-operator";

export interface RuntimeLaunchInput {
  home: string;
  roomId: string;
  port: number;
  publicUrl: string;
  logPath: string;
  sessionName: string;
  tmuxAvailable: boolean;
  runtimeReachable: boolean;
  // The host's actual CLI invocation (shell-ready, e.g. `'/usr/bin/node' '/…/cli.js'`)
  // so a detached/manual relaunch runs the SAME CLI/build the host runs — not a
  // possibly-different global `agentgather` that could serve stale assets.
  cliInvocation: string;
  // false when the host CLI entry could not be resolved (fell back to a bare
  // `agentgather`); the plan then surfaces the CLI source so the operator can
  // verify they relaunch the host's own CLI.
  cliResolved: boolean;
}

export interface RuntimeLaunchPlan {
  strategy: RuntimeStrategy;
  runtimeState: RuntimeState;
  sessionName: string;
  logPath: string;
  // `AGENTGATHER_HOME=… agentgather room serve --port … --url …` — no token.
  serveCommand: string;
  // The detached launch (tmux) when available, else null.
  detachedCommand: string | null;
  stopCommand: string;
  statusCommand: string;
  // The CLI source the generated commands invoke, and whether it was resolved
  // from the host process (vs a best-effort fallback the operator should verify).
  cliSource: string;
  cliResolved: boolean;
  // Human-readable note on who keeps the runtime alive.
  ownership: string;
}

// Canonical POSIX single-quoting: wrap in single quotes, escaping any embedded
// single quote as '\''. Keeps paths/URLs inert as one shell argument.
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Strip credential-bearing parts of a public URL before it lands in a command or
// status surface: drop any `?token=`/query, `#token=`/fragment, and userinfo,
// while preserving scheme/host/port/path (e.g. a broker slug path). Defends the
// no-raw-token / no-full-invite-URL invariant regardless of caller input.
export function sanitizePublicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function resolveRuntimeState(tmuxAvailable: boolean, runtimeReachable: boolean): RuntimeState {
  if (runtimeReachable) return "runtime-running";
  return tmuxAvailable ? "runtime-unreachable" : "manual-run-required";
}

export function buildRuntimeLaunchPlan(input: RuntimeLaunchInput): RuntimeLaunchPlan {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  // Never embed a credential-bearing URL in a generated command/status surface.
  const publicUrl = sanitizePublicUrl(input.publicUrl);
  // Relaunch the host's OWN CLI (resolved from the host process), so a detached
  // or manual restart can't pick up a different/global build serving stale assets.
  const serveCommand =
    `AGENTGATHER_HOME=${shellSingleQuote(input.home)} ${input.cliInvocation} room serve` +
    ` --port ${input.port} --url ${shellSingleQuote(publicUrl)}`;
  const cliWarning = input.cliResolved
    ? ""
    : ` Could not resolve the host CLI source — verify these commands use the host's own agentgather (shown as: ${input.cliInvocation}).`;
  const strategy: RuntimeStrategy = input.tmuxAvailable ? "detached-tmux" : "manual-operator";
  const runtimeState = resolveRuntimeState(input.tmuxAvailable, input.runtimeReachable);
  // A token-free liveness probe: the room shell needs no auth, so any HTTP
  // response means the runtime is up.
  const httpProbe = `curl -sS -o /dev/null -w '%{http_code}\\n' ${shellSingleQuote(publicUrl)}`;

  if (input.tmuxAvailable) {
    const detachedCommand =
      `tmux new-session -d -s ${shellSingleQuote(input.sessionName)} ` +
      shellSingleQuote(`${serveCommand} >> ${shellSingleQuote(input.logPath)} 2>&1`);
    return {
      strategy,
      runtimeState,
      sessionName: input.sessionName,
      logPath: input.logPath,
      serveCommand,
      detachedCommand,
      stopCommand: `tmux kill-session -t ${shellSingleQuote(input.sessionName)}`,
      statusCommand: `tmux has-session -t ${shellSingleQuote(input.sessionName)} && ${httpProbe}`,
      cliSource: input.cliInvocation,
      cliResolved: input.cliResolved,
      ownership:
        `A detached tmux session "${input.sessionName}" keeps ${input.roomId} live, ` +
        "so the agent session does not hold the server in the foreground. Stop it with the stop command." +
        cliWarning
    };
  }

  return {
    strategy,
    runtimeState,
    sessionName: input.sessionName,
    logPath: input.logPath,
    serveCommand,
    detachedCommand: null,
    stopCommand: "Press Ctrl-C in the operator terminal running `room serve`.",
    statusCommand: httpProbe,
    cliSource: input.cliInvocation,
    cliResolved: input.cliResolved,
    ownership:
      `No detachable runner (tmux) was found, so a human operator must run the serve command ` +
      `for ${input.roomId} and keep that terminal open to keep the room live.` +
      cliWarning
  };
}
