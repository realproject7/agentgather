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
  /**
   * Open a diagnostic window around the action being awaited (@re1, PR #295).
   * Counting every request since the recorder started cannot answer "did THIS
   * action issue one": a real page has already loaded, so the baseline traffic
   * makes `requestsIssued > 0` regardless, and never-requested becomes
   * indistinguishable from requested-and-blocked — the one distinction the
   * artifact exists to make. `target` names what is being awaited.
   */
  beginAction(target: string): void;
  /** Write the artifact and return its path. Call only on failure. */
  write(label: string, error: unknown): Promise<string>;
  /**
   * Feed a second page into the same log. The awaited action sometimes happens
   * on a page opened mid-test (a fresh tab, a popup); without this its traffic
   * is invisible and the action window would read zero requests no matter what
   * happened — the same blindness @re1 found in the whole-run count.
   */
  attachPage(page: Page, tag: string): void;
  /** The events recorded so far, for assertions about the recorder itself. */
  events(): DiagnosticEvent[];
}

// #303 (@re1, PR #304): the prefix that marks a failure which happened BEFORE a
// recorder existed. It is carried in the FILENAME so the status report can
// classify a run without reading any artifact's contents.
export const UNATTACHED_PREFIX = "unattached--";

// A test can throw between entering its `try` and reaching `newPage()` — a
// browser that fails to open a page, an await placed before the attach. The
// recorder is null there, and the old catch wrote nothing at all, which is
// exactly the absent-versus-quiet collapse #303 exists to remove. This records
// the one fact that is knowable at that point: the test failed, and no recorder
// had attached. It holds no page data because there was no page.
export async function writeUnattachedFailure(label: string, error: unknown): Promise<string> {
  const file = path.join(DIAGNOSTICS_DIR, `${UNATTACHED_PREFIX}${label.replace(/[^a-z0-9._-]+/gi, "-")}.json`);
  await mkdir(DIAGNOSTICS_DIR, { recursive: true });
  const report = {
    label,
    attached: false,
    reached: "the test threw before a recorder was attached to a page",
    failure: redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  };
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return file;
}

// The one call every wired catch makes. Whichever branch runs, a failed browser
// block now leaves a record that names itself and states whether a recorder was
// there — instead of leaving nothing and letting the run be read as quiet.
export async function captureBrowserFailure(
  diagnostics: BrowserDiagnostics | null,
  label: string,
  error: unknown
): Promise<string> {
  return diagnostics === null ? writeUnattachedFailure(label, error) : diagnostics.write(label, error);
}

// Attach to a page and its context. Nothing is written unless `write` is called,
// so a passing run produces no artifact and costs only in-memory events.
export function recordBrowserDiagnostics(page: Page, context?: BrowserContext): BrowserDiagnostics {
  const started = Date.now();
  const events: DiagnosticEvent[] = [];
  const add = (kind: string, detail: Record<string, unknown>): void => {
    events.push({ at: Date.now() - started, kind, detail });
  };

  const listen = (target: Page, tag: string): void => {
    const tagged = (kind: string, detail: Record<string, unknown>): void => add(kind, { ...detail, page: tag });

  // (a) "never requested" — if the log holds no `request` for the action, the
  //     click never reached a handler that issued one. In this codebase that has
  //     repeatedly meant a control clicked before its handler was bound.
    target.on("request", (request) =>
      tagged("request", { method: request.method(), url: redactUrl(request.url()), resource: request.resourceType() })
    );
  // (b) "requested and blocked" — a request with no response, or a failure with
  //     the transport's own reason.
    target.on("response", (response) => tagged("response", { status: response.status(), url: redactUrl(response.url()) }));
    target.on("requestfailed", (request) =>
      tagged("requestfailed", { url: redactUrl(request.url()), reason: request.failure()?.errorText ?? "unknown" })
    );
  // (c) "crashed" — a page error, a crash, or a closed page.
    target.on("pageerror", (error) => tagged("pageerror", { message: redactText(error.message) }));
    target.on("crash", () => tagged("crash", {}));
    target.on("close", () => tagged("pageclose", {}));
    target.on("console", (message) => tagged("console", { type: message.type(), text: redactText(message.text()) }));
  // The popup/page event itself: its presence or absence is what separates "the
  // window never opened" from "it opened and something else went wrong".
    target.on("popup", (popup) => tagged("popup", { url: redactUrl(popup.url()) }));
  };

  listen(page, "main");
  context?.on("page", (opened) => add("contextpage", { url: redactUrl(opened.url()), page: "main" }));

  return {
    mark: (step) => add("mark", { step }),
    beginAction: (target) => add("action-start", { target }),
    attachPage: (opened, tag) => {
      add("attach", { page: tag });
      listen(opened, tag);
    },
    events: () => [...events],
    write: async (label, error) => {
      const file = path.join(DIAGNOSTICS_DIR, `${label.replace(/[^a-z0-9._-]+/gi, "-")}.json`);
      await mkdir(DIAGNOSTICS_DIR, { recursive: true });
      // Everything after the last `beginAction`, or the whole run if the test
      // never opened a window. This is the scope the branches are decided on.
      const actionStart = events.map((event) => event.kind).lastIndexOf("action-start");
      const windowed = actionStart === -1 ? events : events.slice(actionStart + 1);
      const summarize = (scope: DiagnosticEvent[]): Record<string, unknown> => ({
        requestsIssued: scope.filter((event) => event.kind === "request").length,
        responsesSeen: scope.filter((event) => event.kind === "response").length,
        requestsFailed: scope.filter((event) => event.kind === "requestfailed").length,
        pagesOpened: scope.filter((event) => event.kind === "popup" || event.kind === "contextpage").length,
        crashed: scope.some((event) => event.kind === "crash" || event.kind === "pageerror")
      });
      const report = {
        label,
        // #303 (@re1): the artifact states the RUNTIME attachment fact. Source
        // coverage proves a block contains attachment code, not that this
        // execution reached it — see `writeUnattachedFailure` for the record a
        // failure before that point produces.
        attached: true,
        failure: redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
        durationMs: Date.now() - started,
        // What was being awaited when it failed, so the window has a subject.
        awaiting: actionStart === -1 ? null : (events[actionStart]?.detail.target ?? null),
        // THE branches, scoped to the awaited action. A page that loaded fine and
        // then never issued the action's request reads `requestsIssued: 0` here
        // while `overall` shows the baseline traffic — which is precisely the
        // distinction a whole-run count destroys.
        branches: summarize(windowed),
        // Kept for context: the session as a whole.
        overall: summarize(events),
        events
      };
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return file;
    }
  };
}
