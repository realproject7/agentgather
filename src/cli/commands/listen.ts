import type { Server } from "node:http";

export interface ListenOutcome {
  ok: boolean;
  error?: NodeJS.ErrnoException;
}

// Bind a foreground server, guarding the one-shot 'error' event so an occupied or
// invalid bind resolves as a failure outcome instead of throwing an uncaught
// Server error or hanging the listen promise forever. This only observes its own
// listen attempt — it never inspects, kills, or mutates any other process's
// listener. On success the error guard is removed so post-bind behavior is
// unchanged from a bare `server.listen`.
export function listenOrError(server: Server, port: number, host: string): Promise<ListenOutcome> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener("error", onError);
      resolve({ ok: false, error });
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve({ ok: true });
    });
  });
}

// A controlled, token-free message for a bind failure. It uses only the bind
// coordinates (host/port) and the OS error code — never request, token, or
// message data — so it is always safe to write to stderr.
export function listenErrorMessage(host: string, port: number, error: NodeJS.ErrnoException | undefined): string {
  const target = `${host}:${port}`;
  switch (error?.code) {
    case "EADDRINUSE":
      return `Cannot bind ${target}: address already in use.`;
    case "EACCES":
      return `Cannot bind ${target}: permission denied.`;
    case "EADDRNOTAVAIL":
      return `Cannot bind ${target}: address not available on this host.`;
    default:
      return `Cannot bind ${target}${error?.code ? `: ${error.code}` : ""}.`;
  }
}
