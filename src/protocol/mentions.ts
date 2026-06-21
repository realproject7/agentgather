import { isSafeSlug } from "./validation.js";

export function parseMentions(text: string, participantAliases: Iterable<string>): string[] {
  const roster = new Set(
    [...participantAliases].filter((alias) => isSafeSlug(alias))
  );
  const visibleText = maskCode(text);
  const found: string[] = [];
  const seen = new Set<string>();
  const matcher = /(^|[^\w-])@([a-z0-9-]+)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(visibleText)) !== null) {
    const alias = match[2];
    if (alias === undefined || !roster.has(alias) || seen.has(alias)) continue;
    seen.add(alias);
    found.push(alias);
  }

  return found;
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
