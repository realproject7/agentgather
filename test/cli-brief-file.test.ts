import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import type { CliContext } from "../src/cli/context.js";
import { runRoomCommand } from "../src/cli/commands/room/index.js";
import { readBrief } from "../src/storage/index.js";

// #114: hosts can author a multiline Markdown brief from a file so real newlines
// land in brief.md, instead of shell-escaped literal `\n` that renders visibly.

class Capture extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

async function makeContext(): Promise<{ context: CliContext; stdout: Capture }> {
  const stdout = new Capture();
  return {
    context: { home: await mkdtemp(path.join(os.tmpdir(), "agentgather-114-")), stdout, stderr: new Capture() },
    stdout
  };
}

const MULTILINE = "# Goal\n\nDogfood the merged surface.\n\n- item one\n- item two\n";

test("room start --brief-file writes a multiline brief with real newlines (no literal backslash-n)", async () => {
  const { context } = await makeContext();
  const briefPath = path.join(context.home, "brief.md");
  await writeFile(briefPath, MULTILINE, "utf8");

  await runRoomCommand(["start", "brief-room", "--alias", "host", "--brief-file", briefPath, "--json"], context);

  const brief = await readBrief(context.home, "brief-room");
  assert.equal(brief.body, MULTILINE);
  assert.equal(brief.body.includes("\n"), true, "brief must contain real newlines");
  assert.equal(brief.body.includes("\\n"), false, "brief must not contain literal backslash-n");
});

test("room brief set --brief-file updates the brief with real newlines", async () => {
  const { context } = await makeContext();
  await runRoomCommand(["start", "set-room", "--alias", "host", "--brief", "seed", "--json"], context);

  const briefPath = path.join(context.home, "updated.md");
  await writeFile(briefPath, MULTILINE, "utf8");
  await runRoomCommand(["brief", "set", "--brief-file", briefPath, "--json"], context);

  const brief = await readBrief(context.home, "set-room");
  assert.equal(brief.body, MULTILINE);
  assert.equal(brief.brief_version, 2);
});

test("room create-boardroom --brief-file writes a multiline brief with real newlines", async () => {
  const { context } = await makeContext();
  const briefPath = path.join(context.home, "board-brief.md");
  await writeFile(briefPath, MULTILINE, "utf8");

  await runRoomCommand(
    ["create-boardroom", "board", "--channels", "general:chat", "--brief-file", briefPath, "--json"],
    context
  );

  const brief = await readBrief(context.home, "board");
  assert.equal(brief.body, MULTILINE);
});

test("inline --brief still works (backward compatible)", async () => {
  const { context } = await makeContext();
  await runRoomCommand(["start", "inline-room", "--alias", "host", "--brief", "Ship it.", "--json"], context);
  const brief = await readBrief(context.home, "inline-room");
  assert.equal(brief.body, "Ship it.");
});

test("--brief-file with a missing/unreadable path fails with a clear error", async () => {
  const { context } = await makeContext();
  const missing = path.join(context.home, "does-not-exist.md");
  await assert.rejects(
    () => runRoomCommand(["start", "err-room", "--alias", "host", "--brief-file", missing, "--json"], context),
    /could not read --brief-file/
  );
});

test("passing both --brief and --brief-file is rejected", async () => {
  const { context } = await makeContext();
  const briefPath = path.join(context.home, "both.md");
  await writeFile(briefPath, MULTILINE, "utf8");
  await assert.rejects(
    () =>
      runRoomCommand(
        ["start", "both-room", "--alias", "host", "--brief", "inline", "--brief-file", briefPath, "--json"],
        context
      ),
    /provide either --brief or --brief-file, not both/
  );
});
