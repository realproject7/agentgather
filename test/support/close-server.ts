// #258: shut a test HTTP server down so the process can actually exit.
//
// `server.close()` stops NEW connections but waits for existing ones to end. Node's
// own `fetch` (undici) and a browser page both keep sockets alive after a response,
// so a surviving keep-alive socket leaves the close callback pending forever — and
// with it the awaiting `finally`, the event loop, and the test process. Nothing
// times out: `--test-timeout` is per test and does not cover a process held open by
// a live handle after its tests have finished. That is exactly how a full local run
// came to sit on `cli-room` at 0% CPU indefinitely.
//
// Dropping the connections first makes shutdown deterministic. This is teardown —
// every assertion has already run — so nothing observable is cut short.
//
// Production shutdown is deliberately NOT changed: a real server should drain its
// clients. This is a test-harness concern only.
import type { Server } from "node:http";

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
