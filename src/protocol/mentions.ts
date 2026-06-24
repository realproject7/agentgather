import { isSafeSlug } from "./validation.js";

/**
 * Result of scanning a message for @mentions: aliases that resolve to a roster
 * member (`mentions`) and @-tokens that look like a mention but match nobody
 * (`unknown`). Both lists are deduplicated and ordered by first appearance, and
 * both ignore @-tokens inside fenced or inline code.
 */
export interface MentionAnalysis {
  mentions: string[];
  unknown: string[];
}

/**
 * Scan `text` for @mentions against a roster, returning both the resolved
 * aliases and the unknown @-tokens. Code spans are masked first so a mention
 * inside ``code`` never resolves or warns. This is the single source of truth
 * for both the server (which stores `mentions`) and the browser composer (which
 * warns on `unknown`).
 */
export function analyzeMentions(text: string, participantAliases: Iterable<string>): MentionAnalysis {
  const roster = new Set([...participantAliases].filter((alias) => isSafeSlug(alias)));
  const visibleText = maskCode(text);
  const mentions: string[] = [];
  const unknown: string[] = [];
  const seenMention = new Set<string>();
  const seenUnknown = new Set<string>();
  const matcher = /(^|[^\w-])@([a-z0-9-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(visibleText)) !== null) {
    const alias = match[2];
    if (alias === undefined) continue;
    if (roster.has(alias)) {
      if (seenMention.has(alias)) continue;
      seenMention.add(alias);
      mentions.push(alias);
    } else {
      if (seenUnknown.has(alias)) continue;
      seenUnknown.add(alias);
      unknown.push(alias);
    }
  }

  return { mentions, unknown };
}

export function parseMentions(text: string, participantAliases: Iterable<string>): string[] {
  return analyzeMentions(text, participantAliases).mentions;
}

function maskCode(text: string): string {
  const maskedLines: string[] = [];
  let inFence = false;

  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      maskedLines.push(" ".repeat(line.length));
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      maskedLines.push(" ".repeat(line.length));
      continue;
    }

    maskedLines.push(maskInlineCode(line));
  }

  return maskedLines.join("\n");
}

function maskInlineCode(line: string): string {
  let result = "";
  let inInline = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "`") {
      inInline = !inInline;
      result += " ";
      continue;
    }
    result += inInline ? " " : char;
  }

  return result;
}
