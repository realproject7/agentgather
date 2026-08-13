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

/** Product defaults that must never appear as an address in the test surface. */
export const DEFAULT_ENDPOINT_PATTERN = /127\.0\.0\.1:(8787|8788)\b/;

export interface DefaultEndpointHit {
  file: string;
  line: number;
  text: string;
}

const SURFACE_DIRS = ["test", path.join("test", "e2e"), path.join("test", "support")];

function inSurface(dir: string, entry: string): boolean {
  if (dir === "test") return /^browser-.*\.test\.ts$/.test(entry);
  return entry.endsWith(".ts");
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
  for (const dir of SURFACE_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(path.join(repoRoot, dir));
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!inSurface(dir, entry)) continue;
      const file = path.join(dir, entry);
      const text = await readFile(path.join(repoRoot, file), "utf8");
      text.split("\n").forEach((line, index) => {
        if (!DEFAULT_ENDPOINT_PATTERN.test(line)) return;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        hits.push({ file, line: index + 1, text: trimmed });
      });
    }
  }
  return hits;
}
