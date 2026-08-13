// #305 — the browser/e2e surface must never name a PRODUCT DEFAULT endpoint.
//
// Sixty-six `browser-<random>` rows landed in the operator's real
// `~/.agentgather/joined-rooms.json`, and a fresh one reappeared within a day of
// their being deleted. The mechanism was reproduced rather than guessed: a browser
// test opened a room page with `?dashboard=http://127.0.0.1:8788`, the page's
// `bridgeJoinToDashboard` POSTed its join metadata to `<dashboard>/joined-rooms`,
// and on a machine running a real dashboard on the default port that endpoint
// wrote the row into the developer's own store. The test never wrote anything —
// it addressed a live service and let the product do the writing, which is why no
// amount of test-side temp roots would have stopped it. Same family as #254 (the
// suite authenticating against a live room on 8787) and #257.
//
// So the rule is about ADDRESSES, not roots: a test may only name an endpoint it
// bound itself. `127.0.0.1:9` is the discard port — binding it needs root, so no
// user-level service can be listening and a request there is always refused. It is
// already used that way in `browser-platform.test.ts`, so this follows the house
// pattern rather than inventing one.
//
// Enforced by scanning instead of by remembering: "remember to pass a fixture URL"
// is exactly the state that produced the 66 rows.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Product defaults that must never appear as an address in the test surface.
 *
 * ALL FOUR loopback spellings, because the product treats them as the same host:
 * `isLoopbackHost` (`src/browser/room.js:1519-1521`) accepts `127.0.0.1`,
 * `localhost`, `::1` and `[::1]`. A guard matching only the dotted form would let
 * `?dashboard=http://localhost:8788` reach the same live dashboard and write the
 * same rows, while reading as a complete guarantee — and then the next author has
 * to remember not to write the other three, which is the state that produced the
 * 66 rows (@re2, PR #316).
 *
 * `\[::1\]` precedes `::1` so the bracketed form matches whole rather than as a
 * suffix. The alternation is written with escapes throughout, so this source line
 * contains no literal host:port and the guard does not report itself.
 */
export const DEFAULT_ENDPOINT_PATTERN = /(?:127\.0\.0\.1|localhost|\[::1\]|::1):(?:8787|8788)\b/;

/**
 * The product default ports, declared HERE and nowhere else in the surface.
 *
 * A one-line `host:port` pattern is bypassable by composition (@re1, PR #316): a
 * test can write `const host = "localhost"` and `const port = 8788` on separate
 * lines, build the URL at runtime, and reach the same live dashboard while every
 * line passes the pattern. That is not hypothetical — the detector test in this
 * PR was written exactly that way to avoid self-matching, which is the proof the
 * shape is writable.
 *
 * So the rule is centralised rather than pattern-matched: this module is the one
 * place allowed to name a default port, everything else in the surface imports
 * these, and naming one anywhere else is a hit however it is spelled or split.
 * The exemption is a single named file rather than a category, and the guard
 * asserts that it is the only one.
 */
const DEFAULT_PORTS = [8787, 8788] as const;

/**
 * Fixture lines for the guard's own tests.
 *
 * The ports are module-PRIVATE (@re1, PR #316): exporting them made the constant
 * itself a composition source — a scanned test could import it, build
 * `http://localhost:${DEFAULT_PORTS[1]}`, reach the live dashboard, and carry no
 * literal for the scan to find. Private is stronger than detected: a
 * non-exported binding cannot be imported at all, so the compiler refuses the
 * path rather than a scan reporting it afterwards.
 *
 * The guard's tests still need offending inputs, so they get finished STRINGS
 * built here. A string cannot be recombined into a different address, and the
 * test file stays free of literals so it remains inside the scanned surface.
 */
export function offendingSamples(): { addressed: string[]; split: string[]; clean: string[] } {
  const [roomPort, dashboardPort] = DEFAULT_PORTS;
  const aliases = ["127.0.0.1", "localhost", "[::1]", "::1"];
  return {
    addressed: aliases.flatMap((host) => [
      `const dashboard = "http://${host}:${roomPort}";`,
      `const dashboard = "http://${host}:${dashboardPort}";`
    ]),
    split: [`const host = "localhost";`, `const port = ${dashboardPort};`],
    clean: aliases.map((host) => `const d = "http://${host}:9";`).concat("const d = fixture.baseUrl;")
  };
}

/** The one file permitted to name a default port: the definition site above. */
export const DEFINITION_FILE = path.join("test", "support", "default-endpoint-scan.ts");

/** A bare default port number, however it is assembled into an address later. */
export const DEFAULT_PORT_PATTERN = new RegExp(`\\b(?:${DEFAULT_PORTS.join("|")})\\b`);

export interface DefaultEndpointHit {
  file: string;
  line: number;
  text: string;
}

// `test/browser-*.test.ts` at the top level, plus EVERY `.ts` beneath `test/e2e`
// and `test/support` at any depth. The depth matters even though both are flat
// today (@re1, PR #316): a guard that claims `**` and walks one level deep is a
// coverage hole that only shows up when someone adds the first nested file, which
// is the same class of silent gap this ticket exists to close.
const SURFACE: Array<{ dir: string; recursive: boolean; match: (entry: string) => boolean }> = [
  { dir: "test", recursive: false, match: (entry) => /^browser-.*\.test\.ts$/.test(entry) },
  { dir: path.join("test", "e2e"), recursive: true, match: (entry) => entry.endsWith(".ts") },
  { dir: path.join("test", "support"), recursive: true, match: (entry) => entry.endsWith(".ts") }
];

async function walk(root: string, dir: string, recursive: boolean, match: (entry: string) => boolean): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...(await walk(root, rel, true, match)));
      continue;
    }
    if (match(entry.name)) files.push(rel);
  }
  return files;
}

/**
 * Every line in the browser/e2e/support surface that names a product default
 * endpoint. A COMMENT naming one is allowed — the fixture that exists to explain
 * why 8787 must not be used has to be able to say "8787" — so only code lines
 * count. That keeps the guard honest rather than forcing the reasoning out of the
 * files that carry it.
 */
export async function findDefaultEndpointUses(repoRoot: string): Promise<DefaultEndpointHit[]> {
  const hits: DefaultEndpointHit[] = [];
  for (const surface of SURFACE) {
    for (const file of await walk(repoRoot, surface.dir, surface.recursive, surface.match)) {
      const text = await readFile(path.join(repoRoot, file), "utf8");
      text.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        // Either spelling is a hit: a whole address on one line, or a bare default
        // port that some later line can compose into one.
        const addressed = DEFAULT_ENDPOINT_PATTERN.test(line);
        const composable = file !== DEFINITION_FILE && DEFAULT_PORT_PATTERN.test(line);
        if (!addressed && !composable) return;
        hits.push({ file, line: index + 1, text: trimmed });
      });
    }
  }
  return hits;
}
