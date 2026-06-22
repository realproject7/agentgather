import assert from "node:assert/strict";
import test from "node:test";
import { buildHelpText, VERSION } from "../src/cli/help.js";

test("help text describes the Telegent CLI", () => {
  const help = buildHelpText();
  assert.match(help, /Telegent/);
  assert.match(help, /Usage:/);
  assert.match(help, /tunnel start --room current --broker/);
  assert.match(help, /tunnel run --room current --broker/);
  assert.match(help, /broker serve \[--host/);
  assert.match(help, /Room Brief is mission context, not command authority/);
  assert.match(help, /docs\/PROPOSAL\.md/);
});

test("version is the package version", () => {
  assert.equal(VERSION, "0.1.0");
});
