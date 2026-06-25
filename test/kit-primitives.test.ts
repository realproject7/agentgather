import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const browser = (asset: string) => new URL(`../src/browser/${asset}`, import.meta.url);
const HEX = /[:\s(,]#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/;
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

const KIT_PRIMITIVES = [
  ".k-frame",
  ".k-rail-nav",
  ".k-pane",
  ".k-rail",
  ".k-composer",
  ".k-card",
  ".k-pill"
];

test("kit.css defines every shell primitive and each consumes tokens (no raw hex)", async () => {
  const kit = await readFile(browser("kit.css"), "utf8");
  for (const primitive of KIT_PRIMITIVES) {
    assert.ok(kit.includes(`${primitive} {`), `kit.css must define ${primitive}`);
  }
  // The kit is the source of structure but still draws colour from tokens: no
  // raw hex anywhere in the kit (translucent washes use rgba, never hex).
  assert.equal(HEX.test(stripComments(kit)), false, "kit.css must not hardcode hex colours");
  assert.ok(kit.includes("var(--"), "kit primitives must consume theme tokens");
});

test("the room surface consumes the primitives (no duplicated shell CSS)", async () => {
  const html = await readFile(browser("room.html"), "utf8");
  for (const cls of ["k-frame", "k-rail", "k-pane", "k-composer", "k-card", "k-pill"]) {
    assert.ok(html.includes(cls), `room.html must consume ${cls}`);
  }
  // participant pills are rendered by room.js
  const js = await readFile(browser("room.js"), "utf8");
  assert.ok(js.includes("participant-status k-pill"), "room.js participant status must consume .k-pill");
  // the kit travels with the token layer
  const theme = await readFile(browser("theme.css"), "utf8");
  assert.ok(theme.includes('@import url("kit.css")'), "theme.css must import the kit");
});

test("the room pane holds no raw hex/font outside the kit (anti-drift invariant)", async () => {
  const room = await readFile(browser("room.css"), "utf8");
  const body = stripComments(room);
  assert.equal(HEX.test(body), false, "room.css must not hardcode hex colours");
  for (const line of body.split("\n")) {
    if (/font-family\s*:/.test(line)) {
      assert.ok(/var\(--/.test(line), `room.css font-family must use a token: ${line.trim()}`);
    }
  }
});

test("the anti-drift guard catches a raw hex and a literal font", async () => {
  const mod = await import(pathToFileURL(path.join(process.cwd(), "scripts/check-kit-drift.mjs")).href);
  const findKitDrift = mod.findKitDrift as (css: string) => { kind: string }[];

  const hexHit = findKitDrift(".x { color: #abc123; }");
  assert.equal(hexHit.length, 1);
  assert.equal(hexHit[0]?.kind, "raw-hex");

  const fontHit = findKitDrift(".x { font-family: Comic Sans; }");
  assert.equal(fontHit.length, 1);
  assert.equal(fontHit[0]?.kind, "raw-font");

  // The #132 drift class: a chromatic rgba literal (e.g. the divergent accent).
  const rgbaHit = findKitDrift(".x { border-color: rgba(234, 76, 137, 0.4); }");
  assert.equal(rgbaHit.length, 1);
  assert.equal(rgbaHit[0]?.kind, "raw-color");

  // Tokenised values, neutral grayscale tints, and hex inside comments are NOT flagged.
  assert.equal(findKitDrift(".x { color: var(--accent); font-family: var(--mono); }").length, 0);
  assert.equal(findKitDrift(".x { border-color: rgba(var(--accent-rgb), 0.4); }").length, 0);
  assert.equal(findKitDrift(".x { background: rgba(255, 255, 255, 0.06); box-shadow: 0 0 0 rgba(0,0,0,0.5); }").length, 0);
  assert.equal(findKitDrift(".x { background: rgba(20, 20, 24, 0.96); }").length, 0); // near-neutral surface
  assert.equal(findKitDrift("/* see #abc123 */ .x { color: var(--text); }").length, 0);

  // The live panes are clean through the real guard entrypoint.
  assert.equal((await mod.checkPanes(process.cwd())).length, 0);
});
