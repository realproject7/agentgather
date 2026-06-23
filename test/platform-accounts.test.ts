import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createControlPlaneRoom,
  createDevOwnerAccount,
  devOwnerIdentityFromEnv,
  listRoomsResponse,
  PlatformAccountValidationError,
  readRoomResponse,
  resolveOwnerAccount,
  sanitizeAccount
} from "../src/platform/index.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentgather-platform-accounts-test-"));
}

test("dev owner identity creates a concrete account with nullable provider fields", () => {
  const now = new Date("2026-06-23T00:00:00.000Z");
  const account = createDevOwnerAccount({ userId: "operator-1", displayName: "Operator", now });
  assert.deepEqual(account, {
    user_id: "operator-1",
    display_name: "Operator",
    email: null,
    external_identity: null,
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-23T00:00:00.000Z"
  });
});

test("dev owner identity can be configured from environment variables", () => {
  const config = devOwnerIdentityFromEnv({
    AGENTGATHER_DEV_OWNER_ID: "project7",
    AGENTGATHER_DEV_OWNER_NAME: "Project Seven",
    AGENTGATHER_DEV_OWNER_EMAIL: "owner@example.com",
    AGENTGATHER_DEV_OWNER_PROVIDER: "github",
    AGENTGATHER_DEV_OWNER_SUBJECT: "realproject7"
  });
  const account = createDevOwnerAccount({ ...config, now: new Date("2026-06-23T01:00:00.000Z") });
  assert.equal(account.user_id, "project7");
  assert.equal(account.display_name, "Project Seven");
  assert.equal(account.email, "owner@example.com");
  assert.deepEqual(account.external_identity, { provider: "github", subject: "realproject7" });
});

test("external identity env values must be configured as a pair", () => {
  assert.throws(
    () => devOwnerIdentityFromEnv({ AGENTGATHER_DEV_OWNER_PROVIDER: "github" }),
    PlatformAccountValidationError
  );
});

test("account validation rejects unsupported fields and sensitive room data", () => {
  const base = createDevOwnerAccount({ userId: "safe-owner", now: new Date("2026-06-23T02:00:00.000Z") });
  assert.throws(() => sanitizeAccount({ ...base, invite_url: "https://rooms.agentgather.dev/r#token=tgl_x" }), {
    name: "PlatformAccountValidationError"
  });
  assert.throws(() => sanitizeAccount({ ...base, billing_plan: "pro" }), {
    name: "PlatformAccountValidationError"
  });
  assert.throws(() => createDevOwnerAccount({ userId: "tgl_secret" }), {
    name: "PlatformAccountValidationError"
  });
});

test("owner resolution accepts a concrete account, dev owner config, or legacy owner id", () => {
  const account = createDevOwnerAccount({ userId: "account-owner", now: new Date("2026-06-23T03:00:00.000Z") });
  assert.equal(resolveOwnerAccount({ account })?.user_id, "account-owner");
  assert.equal(resolveOwnerAccount({ dev_owner: { userId: "dev-owner" } })?.user_id, "dev-owner");
  assert.equal(resolveOwnerAccount({ owner_user_id: "legacy-owner" })?.user_id, "legacy-owner");
  assert.equal(resolveOwnerAccount({}), null);
});

test("platform API can scope rooms using the dev owner account boundary", async () => {
  const root = await makeRoot();
  await createControlPlaneRoom(root, {
    room_id: "owned-room",
    title: "Owned",
    owner_user_id: "project7",
    route_url: "https://rooms.agentgather.dev/owned-room",
    status: "active",
    last_synced_message_id: 0
  });
  await createControlPlaneRoom(root, {
    room_id: "other-room",
    title: "Other",
    owner_user_id: "someone-else",
    route_url: "https://rooms.agentgather.dev/other-room",
    status: "idle",
    last_synced_message_id: 0
  });

  const list = await listRoomsResponse(root, { dev_owner: { userId: "project7", displayName: "Project Seven" } });
  assert.equal(list.status, 200);
  const body = list.body as { rooms: Array<{ room_id: string }> };
  assert.deepEqual(body.rooms.map((room) => room.room_id), ["owned-room"]);

  const owned = await readRoomResponse(root, "owned-room", { account: createDevOwnerAccount({ userId: "project7" }) });
  assert.equal(owned.status, 200);

  const hidden = await readRoomResponse(root, "other-room", { dev_owner: { userId: "project7" } });
  assert.equal(hidden.status, 404);
});
