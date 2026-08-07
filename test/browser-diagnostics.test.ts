// #289 — proves the failure-only diagnostics against a CAPTURED ARTIFACT, not
// against the configuration (operator condition 1).
//
// The fixture deliberately does the two things that would leak on a public repo:
// it authenticates with a real bearer token and it navigates to a URL carrying a
// token in the fragment. Then a failure is forced, the artifact is written, and
// the file on disk is read back and searched. Asserting on config would prove the
// intent; only reading the artifact proves the outcome.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { AddressInfo, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createRoomHttpServer, participantTokenHash } from "../src/server/index.js";
import { createRoom, writeParticipants } from "../src/storage/index.js";
import type { Participant } from "../src/protocol/index.js";
import { closeServer } from "./support/close-server.js";
import { captureBrowserFailure, recordBrowserDiagnostics, redactUrl } from "./support/browser-diagnostics.js";

const SECRET = "tgl_diagnostics_secret_9f2c";

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function participant(alias: string, kind: Participant["kind"], isHost: boolean, token: string): Participant {
  return {
    alias,
    kind,
    location: "local",
    install: "lite",
    attention: "attending",
    is_host: isHost,
    token_hash: participantTokenHash(token),
    joinedAt: new Date(0).toISOString(),
    lastSeenAt: new Date(0).toISOString()
  };
}

test("a captured failure artifact contains no credential, in any of its fields (#289)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-diagnostics-test-"));
  const roomId = "diagnostics-room";
  await createRoom({ root, roomId, hostAlias: "host", briefBody: "Diagnostics fixture." });
  await writeParticipants(root, roomId, [
    { ...participant("host", "human", true, `tgl_host_${roomId}`), display_name: "Host" },
    { ...participant("project7", "human", false, SECRET), display_name: "project7" }
  ]);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId, baseUrl, rateLimitPerMinute: 1_000 });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const browser = await chromium.launch();
  let artifact = "";
  // #303: the recorder under test doubles as this block's own failure recorder —
  // the file that proves the instrument is in the wait surface like any other.
  let live: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage();
    const diagnostics = recordBrowserDiagnostics(page, page.context());
    live = diagnostics;
    // The credential travels exactly as it does in the real fixtures: in the
    // fragment on entry, and then as an Authorization header on every poll.
    await page.goto(`${baseUrl}/#token=${SECRET}`);
    await page.waitForSelector("text=Diagnostics fixture.");
    diagnostics.mark("entered the room with a fragment credential");
    // A query-string carrier too, since that is the other shape this project has
    // had to redact before.
    await page.goto(`${baseUrl}/?token=${SECRET}`);
    artifact = await diagnostics.write("redaction-proof", new Error(`failed while holding ${SECRET}`));

    const captured = await readFile(artifact, "utf8");

    // POSITIVE CONTROL: the recorder actually observed the session. Without this,
    // "no secret in the artifact" would also hold for an empty file — the
    // reassuring-direction instrument failure this project has now hit three
    // times.
    const report = JSON.parse(captured) as {
      events: { kind: string }[];
      branches: { requestsIssued: number; responsesSeen: number };
    };
    assert.ok(report.events.length > 5, `the recorder must have captured a real session, got ${report.events.length}`);
    assert.ok(report.branches.requestsIssued > 0, "requests must have been recorded");
    assert.ok(report.branches.responsesSeen > 0, "responses must have been recorded");
    assert.ok(captured.includes("127.0.0.1"), "the artifact must contain the real host it talked to");

    // THE PROOF: the secret is in the fixture, and not in the artifact.
    assert.equal(captured.includes(SECRET), false, "the artifact must not contain the participant token");
    assert.equal(/tgl_[A-Za-z0-9_-]+/.test(captured), false, "no token-shaped value may survive");
    assert.equal(/Bearer\s+\S+/i.test(captured), false, "no bearer credential may survive");
    // Normalise the redaction marker away first, then assert no token carrier
    // survives — otherwise the marker itself reads as one.
    assert.equal(
      /[#?&]token=[^"&\s]+/i.test(captured.replace(/token=redacted/g, "")),
      false,
      "no token carrier may survive"
    );
    // Headers and bodies are never collected, so they cannot appear at all.
    assert.equal(/authorization/i.test(captured), false, "no header material may appear");
    assert.equal(captured.includes(root), false, "no filesystem path may appear");
  } catch (error) {
    await captureBrowserFailure(live, "redaction-proof-failed", error);
    throw error;
  } finally {
    await browser.close();
    await closeServer(server);
    if (artifact) await rm(artifact, { force: true });
  }
});

test("the artifact distinguishes never-requested from blocked from crashed (#289)", async () => {
  // Operator condition 2: the record must separate the branches in ONE read.
  // Each scenario below is constructed, then the artifact's own summary is
  // asserted — so this tests the discrimination, not the plumbing.
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-diagnostics-branch-test-"));
  const roomId = "branch-room";
  await createRoom({ root, roomId, hostAlias: "host", briefBody: "Branch fixture." });
  await writeParticipants(root, roomId, [
    { ...participant("host", "human", true, "tgl_branch_host"), display_name: "Host" }
  ]);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId, baseUrl, rateLimitPerMinute: 1_000 });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const browser = await chromium.launch();
  const written: string[] = [];
  // #303: this block builds three recorders and asserts their artifacts, so it
  // has no single one to write from. `latest` tracks whichever stage is running,
  // which is the recorder that saw the failure — the file that tests the
  // instrument is in the wait surface like any other.
  let latest: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    // (a) NEVER REQUESTED — a page that loads nothing further. No request for the
    //     action exists, which is what separates this branch from the others.
    const idle = await browser.newPage();
    const idleDiag = recordBrowserDiagnostics(idle, idle.context());
    latest = idleDiag;
    await idle.goto("about:blank");
    const idleFile = await idleDiag.write("branch-never-requested", new Error("nothing was requested"));
    written.push(idleFile);
    const idleReport = JSON.parse(await readFile(idleFile, "utf8")) as { branches: { requestsIssued: number } };
    assert.equal(idleReport.branches.requestsIssued, 0, "the never-requested branch must show zero requests");

    // (b) REQUESTED AND BLOCKED — the request is made and aborted in flight, so
    //     the record shows an issued request with a transport failure.
    const blocked = await browser.newPage();
    const blockedDiag = recordBrowserDiagnostics(blocked, blocked.context());
    latest = blockedDiag;
    await blocked.route("**/*", (route) => route.abort("connectionrefused"));
    await blocked.goto(baseUrl).catch(() => undefined);
    const blockedFile = await blockedDiag.write("branch-blocked", new Error("blocked in flight"));
    written.push(blockedFile);
    const blockedReport = JSON.parse(await readFile(blockedFile, "utf8")) as {
      branches: { requestsIssued: number; requestsFailed: number };
    };
    assert.ok(blockedReport.branches.requestsIssued > 0, "the blocked branch must show the request WAS issued");
    assert.ok(blockedReport.branches.requestsFailed > 0, "the blocked branch must show the transport failure");

    // (c) CRASHED — an uncaught page error is recorded as such.
    const broken = await browser.newPage();
    const brokenDiag = recordBrowserDiagnostics(broken, broken.context());
    latest = brokenDiag;
    await broken.goto(baseUrl);
    await broken.evaluate(() => {
      setTimeout(() => {
        throw new Error("diagnostics fixture page failure");
      }, 0);
    });
    await broken.waitForEvent("pageerror");
    const brokenFile = await brokenDiag.write("branch-crashed", new Error("page raised"));
    written.push(brokenFile);
    const brokenReport = JSON.parse(await readFile(brokenFile, "utf8")) as { branches: { crashed: boolean } };
    assert.equal(brokenReport.branches.crashed, true, "the crashed branch must be flagged");

    // And the three are mutually distinguishable from their summaries alone.
    assert.notDeepEqual(idleReport.branches, blockedReport.branches);
  } catch (error) {
    written.push(await captureBrowserFailure(latest, "branch-discrimination-failed", error));
    throw error;
  } finally {
    await browser.close();
    await closeServer(server);
    for (const file of written) await rm(file, { force: true });
  }
});

test("URL redaction covers the carriers this project actually uses (#289)", () => {
  assert.equal(redactUrl("http://127.0.0.1:9/room#token=tgl_secret_value"), "http://127.0.0.1:9/room");
  assert.equal(redactUrl("http://127.0.0.1:9/r?token=tgl_secret_value"), "http://127.0.0.1:9/r?token=redacted");
  assert.equal(redactUrl("http://127.0.0.1:9/card/tgl_secret_value"), "http://127.0.0.1:9/card/[redacted-token]");
  assert.equal(redactUrl("not a url"), "[unparsable-url]");
  // A URL with nothing sensitive is left legible — redaction that destroys the
  // useful part would make the artifact worthless for its actual purpose.
  assert.equal(redactUrl("http://127.0.0.1:9/messages?since=4"), "http://127.0.0.1:9/messages?since=4");
});

test("a loaded page whose action issues nothing still reads as never-requested (#289)", async () => {
  // @re1's P1 on PR #295: the first version summarised every request since the
  // recorder started. A real test has already loaded a page, so that baseline
  // made `requestsIssued > 0` regardless of whether the AWAITED action issued
  // anything — never-requested and requested-and-blocked became the same
  // artifact. My original proof used `about:blank`, which has no baseline, so it
  // validated the mechanism in the one scenario the real tests never occupy.
  const root = await mkdtemp(path.join(os.tmpdir(), "agentgather-diagnostics-window-test-"));
  const roomId = "window-room";
  await createRoom({ root, roomId, hostAlias: "host", briefBody: "Window fixture." });
  await writeParticipants(root, roomId, [
    { ...participant("host", "human", true, "tgl_window_host"), display_name: "Host" }
  ]);
  const HOST_TOKEN = "tgl_window_host";
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createRoomHttpServer({ root, roomId, baseUrl, rateLimitPerMinute: 1_000 });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const browser = await chromium.launch();
  let artifact = "";
  // #303: as above — the recorder under test is also this block's own recorder.
  let live: ReturnType<typeof recordBrowserDiagnostics> | null = null;
  try {
    const page = await browser.newPage();
    const diagnostics = recordBrowserDiagnostics(page, page.context());
    live = diagnostics;
    // A genuine baseline: the page loads and polls, exactly like the real tests.
    await page.goto(`${baseUrl}/#token=${HOST_TOKEN}`);
    await page.waitForSelector("text=Window fixture.");

    // Now an action that issues nothing at all — the never-requested branch.
    diagnostics.beginAction("an action that never reaches a handler");
    artifact = await diagnostics.write("window-never-requested", new Error("the awaited event never arrived"));

    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      awaiting: string | null;
      branches: { requestsIssued: number };
      overall: { requestsIssued: number };
    };
    // POSITIVE CONTROL: the baseline really happened, so `branches` reading zero
    // is a statement about the action window and not about an idle browser.
    assert.ok(report.overall.requestsIssued > 0, "the page must genuinely have loaded first");
    assert.equal(report.branches.requestsIssued, 0, "the action window must show no request for the action");
    assert.equal(report.awaiting, "an action that never reaches a handler", "the window must name its subject");
  } catch (error) {
    await captureBrowserFailure(live, "window-never-requested-failed", error);
    throw error;
  } finally {
    await browser.close();
    await closeServer(server);
    if (artifact) await rm(artifact, { force: true });
  }
});
