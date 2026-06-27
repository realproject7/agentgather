#!/usr/bin/env node
// Anti-drift guard (#133 / V2 T2B).
//
// Pane stylesheets must consume the shell-primitive kit + the #130 token layer
// and must NOT reintroduce raw hex colours or literal fonts. The kit (kit.css)
// and the token layer (theme.css) are the single place raw values may live, so
// they are exempt. This catches the most common drift signal — a pane
// hardcoding a colour/font instead of reaching for a token/primitive.
//
// Exposed as a function so the test suite can assert it actually catches a
// violation, and runnable as a CLI (wired into `pnpm lint`).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pane stylesheets held to the no-raw-hex/font rule. Raw values live only in
// the kit (kit.css) and the token layer (theme.css); panes consume tokens.
export const PANE_FILES = [
  "src/browser/room.css",
  "src/browser/shell.css",
  "src/browser/forum.css",
  "src/browser/channel-rail.css"
];

// Blank out /* ... */ comments (keeping newlines) so issue refs like `#112`
// inside comments are never flagged.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

/**
 * Find raw-hex / raw-font drift in a pane stylesheet.
 * @returns {{line: number, kind: "raw-hex"|"raw-font"|"raw-color", text: string}[]}
 */
// Near-grayscale UI surface tints (e.g. rgba(20,20,24,…)) are allowed; only
// chromatic literals — brand/status colours, the real drift risk — are flagged.
// A literal is "neutral" when its RGB channel spread is within this tolerance.
const NEUTRAL_SPREAD = 16;
// numeric rgb()/rgba() — a token-backed rgba(var(--…),α) never matches (no digit
// after the paren). Captures the three leading channels.
const RGB_LITERAL = /\b(rgba?)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
// any numeric hsl()/hsla() literal is chromatic enough to flag.
const HSL_LITERAL = /\bhsla?\(\s*\d/;

export function findKitDrift(css) {
  const violations = [];
  const lines = stripComments(css).split("\n");
  lines.forEach((line, index) => {
    // Hex colour values (3/4/6/8 digit), in a value position (after :, space,
    // "(" or ",") so id selectors like `#brief-summary` are never matched.
    const hex = line.match(/[:\s(,]#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/);
    if (hex) {
      violations.push({ line: index + 1, kind: "raw-hex", text: hex[0].trim() });
    }
    // Chromatic raw rgb()/rgba() literals (neutral grayscale tints are fine).
    for (const m of line.matchAll(RGB_LITERAL)) {
      const [r, g, b] = [Number(m[2]), Number(m[3]), Number(m[4])];
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (spread > NEUTRAL_SPREAD) {
        violations.push({ line: index + 1, kind: "raw-color", text: m[0] + ")" });
      }
    }
    if (HSL_LITERAL.test(line)) {
      violations.push({ line: index + 1, kind: "raw-color", text: line.trim() });
    }
    // Literal font declarations (a token-backed `font-family: var(--…)` is fine).
    if (/font-family\s*:/.test(line) && !/var\(--/.test(line)) {
      violations.push({ line: index + 1, kind: "raw-font", text: line.trim() });
    }
  });
  return violations;
}

export async function checkPanes(root = process.cwd()) {
  const all = [];
  for (const rel of PANE_FILES) {
    const css = await readFile(path.join(root, rel), "utf8");
    for (const v of findKitDrift(css)) all.push({ file: rel, ...v });
  }
  return all;
}

// CLI: exit non-zero on any drift.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = await checkPanes();
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}: kit-drift (${v.kind}) — ${v.text}; use a kit primitive or a theme token`);
    }
    console.error(`\n${violations.length} kit-drift violation(s). Raw hex/font must live in kit.css or theme.css, not panes.`);
    process.exit(1);
  }
  console.log(`kit-drift guard: ${PANE_FILES.length} pane stylesheet(s) clean.`);
}
