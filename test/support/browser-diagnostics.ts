// #289 — failure-only diagnostics for browser tests.
//
// Two CI failures decomposed into normal-speed work plus one wait that consumed
// its entire 30s ceiling. That is a MISSING EVENT, and a rerun cannot characterise
// one: `waitForEvent("page")` timing out says the popup never arrived and nothing
// about why. This records enough, only on failure, to tell the branches apart in
// one read.
//
// REDACTION BY CONSTRUCTION (#289 condition 1). This repository is public, and its
// browser fixtures authenticate with real bearer tokens. Rather than capture a
// Playwright trace and strip secrets from it afterwards, this captures **no
// network layer at all** in the sensitive sense: headers and request/response
// bodies are never read, so they cannot leak from an artifact that never held
// them. What is recorded is method, status, resource type, timing, and a URL that
// is redacted before it is stored. Removing a secret is a step that can be
// forgotten; never collecting it cannot be.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

export const DIAGNOSTICS_DIR = "test-artifacts";

interface DiagnosticEvent {
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

// Strip everything credential-shaped from a URL before it is stored: the fragment
// (where this project carries invite tokens), any token-bearing query parameter,
// and any bare `tgl_` value. Mirrors the redaction already applied to snapshots
// (#247) and notification bodies, so one convention covers every sink.
export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "[unparsable-url]";
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    // A marker with no characters that percent-encode: "[redacted]" comes back
    // as "%5Bredacted%5D", which still reads as a token carrier to anything
    // scanning the artifact for one — including this project's own leak checks.
    if (/token|snapshot|credential|auth|card/i.test(key)) url.searchParams.set(key, "redacted");
  }
  return url
    .toString()
    .replace(/tgl_[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/Bearer\s+\S+/gi, "[redacted-credential]");
}

// Console and error text is authored by the page, so it can quote anything the
// page saw — including a URL that carried a token.
function redactText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, (match) => redactUrl(match))
    .replace(/tgl_[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/Bearer\s+\S+/gi, "[redacted-credential]")
    .replace(/[#?&](?:token|snapshot)=[^\s&#"']+/gi, "[redacted-token]")
    .slice(0, 2_000);
}

export interface BrowserDiagnostics {
  /** Note a step the test reached, so the log shows how far it got. */
  mark(step: string): void;
  /** Write the artifact and return its path. Call only on failure. */
  write(label: string, error: unknown): Promise<string>;
  /** The events recorded so far, for assertions about the recorder itself. */
  events(): DiagnosticEvent[];
}

// Attach to a page and its context. Nothing is written unless `write` is called,
// so a passing run produces no artifact and costs only in-memory events.
export function recordBrowserDiagnostics(page: Page, context?: BrowserContext): BrowserDiagnostics {
  const started = Date.now();
  const events: DiagnosticEvent[] = [];
  const add = (kind: string, detail: Record<string, unknown>): void => {
    events.push({ at: Date.now() - started, kind, detail });
  };

  // (a) "never requested" — if the log holds no `request` for the action, the
  //     click never reached a handler that issued one. In this codebase that has
  //     repeatedly meant a control clicked before its handler was bound.
  page.on("request", (request) =>
    add("request", { method: request.method(), url: redactUrl(request.url()), resource: request.resourceType() })
  );
  // (b) "requested and blocked" — a request with no response, or a failure with
  //     the transport's own reason.
  page.on("response", (response) => add("response", { status: response.status(), url: redactUrl(response.url()) }));
  page.on("requestfailed", (request) =>
    add("requestfailed", { url: redactUrl(request.url()), reason: request.failure()?.errorText ?? "unknown" })
  );
  // (c) "crashed" — a page error, a crash, or a closed page.
  page.on("pageerror", (error) => add("pageerror", { message: redactText(error.message) }));
  page.on("crash", () => add("crash", {}));
  page.on("close", () => add("pageclose", {}));
  page.on("console", (message) => add("console", { type: message.type(), text: redactText(message.text()) }));
  // The popup/page event itself: its presence or absence is what separates "the
  // window never opened" from "it opened and something else went wrong".
  page.on("popup", (popup) => add("popup", { url: redactUrl(popup.url()) }));
  context?.on("page", (opened) => add("contextpage", { url: redactUrl(opened.url()) }));

  return {
    mark: (step) => add("mark", { step }),
    events: () => [...events],
    write: async (label, error) => {
      const file = path.join(DIAGNOSTICS_DIR, `${label.replace(/[^a-z0-9._-]+/gi, "-")}.json`);
      await mkdir(DIAGNOSTICS_DIR, { recursive: true });
      const report = {
        label,
        failure: redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
        durationMs: Date.now() - started,
        // A one-read summary of the three branches, so a reader does not have to
        // infer them from the raw log.
        branches: {
          requestsIssued: events.filter((event) => event.kind === "request").length,
          responsesSeen: events.filter((event) => event.kind === "response").length,
          requestsFailed: events.filter((event) => event.kind === "requestfailed").length,
          pagesOpened: events.filter((event) => event.kind === "popup" || event.kind === "contextpage").length,
          crashed: events.some((event) => event.kind === "crash" || event.kind === "pageerror")
        },
        events
      };
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return file;
    }
  };
}
