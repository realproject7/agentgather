// Broker structured logging with deny-by-default redaction.
//
// The broker must never log secrets or room content. This module emits only a
// fixed allowlist of coarse, safe fields. It never accepts headers, bodies,
// tokens, query strings, or full paths: callers pass a derived path class and a
// route hash, and the emitter copies only known-safe keys onto the record.

import { createHash } from "node:crypto";

export interface BrokerLogFields {
  event: string;
  route_hash?: string;
  method?: string;
  path_class?: string;
  status?: number;
  duration_ms?: number;
  bytes_in?: number;
  bytes_out?: number;
  wait_held_ms?: number;
  error?: string;
}

export type BrokerLogSink = (record: Readonly<Record<string, unknown>>) => void;

// Only these keys are ever emitted. Anything else a caller attaches is dropped.
const ALLOWED_FIELDS: ReadonlyArray<keyof BrokerLogFields> = [
  "event",
  "route_hash",
  "method",
  "path_class",
  "status",
  "duration_ms",
  "bytes_in",
  "bytes_out",
  "wait_held_ms",
  "error"
];

/** Default sink: structured JSON line to stderr. */
export const stderrLogSink: BrokerLogSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

export class BrokerLogger {
  private readonly sink: BrokerLogSink;

  constructor(sink: BrokerLogSink = stderrLogSink) {
    this.sink = sink;
  }

  log(fields: BrokerLogFields): void {
    const record: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      const value = fields[key];
      if (value !== undefined) record[key] = value;
    }
    this.sink(record);
  }
}

/** Stable, non-reversible identifier for a route slug, safe to log. */
export function routeHash(slug: string): string {
  return createHash("sha256").update(slug).digest("hex").slice(0, 12);
}

const PATH_CLASSES = new Set([
  "room.css",
  "room.js",
  "markdown.js",
  "forum.html",
  "forum.css",
  "forum.js",
  "theme.css",
  "kit.css",
  "agentgather-logo.png",
  "favicon.png",
  "manifest.webmanifest",
  "brief",
  "attendance",
  "status",
  "messages",
  "wait",
  "card",
  "profile",
  "join",
  "leave",
  "close"
]);

/**
 * Reduce a forwarded path to a coarse class with no query string, parameters,
 * or identifiers. Unknown paths collapse to "other" so nothing sensitive leaks.
 */
export function classifyPath(pathname: string): string {
  const withoutQuery = pathname.split("?", 1)[0] ?? "/";
  const first = withoutQuery.split("/").filter(Boolean)[0];
  if (first === undefined) return "shell";
  if (
    first === "room.css" ||
    first === "room.js" ||
    first === "markdown.js" ||
    first === "forum.html" ||
    first === "forum.css" ||
    first === "forum.js" ||
    first === "theme.css" ||
    first === "kit.css" ||
    first === "agentgather-logo.png" ||
    first === "favicon.png" ||
    first === "manifest.webmanifest"
  ) {
    return "asset";
  }
  return PATH_CLASSES.has(first) ? first : "other";
}
