// #254: shared room-server fixture for CLI tests.
//
// A CLI test that exercises a command which talks to the room over HTTP must
// point that room at a listener the test itself bound. Left on the product
// default base URL the request goes to whatever process owns 127.0.0.1:8787 —
// on a machine running `room serve` the suite authenticates against, and can
// write to, a room it never created.
//
// This is the part every such test needs and had been open-coding: bind a room
// server for an already-created room on a kernel-assigned port, hand back its
// base URL, and close it again. Scenario setup (which room, which participants,
// which context) stays with the caller, because that is what actually differs.
import { AddressInfo } from "node:net";
import { createRoomHttpServer } from "../../src/server/index.js";

export type RoomServerFixture = {
  baseUrl: string;
  close: () => Promise<void>;
};

// `waitHoldMs` is parameterised because two callers need a specific hold: the
// cli-message fixture uses 30ms and the cli-room lifecycle test uses 5ms so
// their /wait assertions return promptly. The other callers take the default.
export async function startRoomServerFixture(
  root: string,
  roomId: string,
  waitHoldMs?: number
): Promise<RoomServerFixture> {
  const server = createRoomHttpServer({
    root,
    roomId,
    baseUrl: "http://127.0.0.1:0",
    ...(waitHoldMs === undefined ? {} : { waitHoldMs })
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Drop client keep-alive sockets first; otherwise close() waits on them
        // and the test process lingers after its assertions finish.
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}
