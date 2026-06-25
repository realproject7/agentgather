// Shared safe Markdown renderer for the browser surfaces (room timeline/brief +
// forum posts/comments). Single implementation so the forum reuses the EXACT
// renderer the room uses — no second renderer, no new injection surface. Output
// is built with the DOM (textContent / createElement), never innerHTML; links
// are restricted to http(s)/mailto. Mention highlighting is opt-in via
// options.mentions (a Set of aliases) so non-room surfaces can omit it.

export function renderSafeMarkdown(parent, markdown, options = {}) {
  const mentions = options.mentions;
  parent.replaceChildren();
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  if (options.compact) {
    appendInlineMarkdown(parent, lines.map(stripMarkdownBlockPrefix).join(" "), mentions);
    return;
  }
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim() === "") {
      cursor += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      cursor += 1;
      while (cursor < lines.length && !lines[cursor].startsWith("```")) {
        codeLines.push(lines[cursor]);
        cursor += 1;
      }
      if (cursor < lines.length) cursor += 1;
      appendCodeBlock(parent, codeLines.join("\n"), lang);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${Math.min(heading[1].length, 3)}`);
      appendInlineMarkdown(element, heading[2], mentions);
      parent.append(element);
      cursor += 1;
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      parent.append(document.createElement("hr"));
      cursor += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (cursor < lines.length && /^>\s?/.test(lines[cursor])) {
        quoteLines.push(lines[cursor].replace(/^>\s?/, ""));
        cursor += 1;
      }
      const blockquote = document.createElement("blockquote");
      appendInlineMarkdown(blockquote, quoteLines.join("\n"), mentions);
      parent.append(blockquote);
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const list = document.createElement(ordered ? "ol" : "ul");
      const pattern = ordered ? /^\d+\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
      while (cursor < lines.length) {
        const match = pattern.exec(lines[cursor]);
        if (!match) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, match[1], mentions);
        list.append(item);
        cursor += 1;
      }
      parent.append(list);
      continue;
    }
    const paragraphLines = [];
    while (cursor < lines.length && lines[cursor].trim() !== "" && !isMarkdownBlockStart(lines[cursor])) {
      paragraphLines.push(lines[cursor]);
      cursor += 1;
    }
    if (options.compact) {
      appendInlineMarkdown(parent, paragraphLines.join(" "), mentions);
    } else {
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, paragraphLines.join("\n"), mentions);
      parent.append(paragraph);
    }
  }
}

export function isMarkdownBlockStart(line) {
  return (
    line.startsWith("```") ||
    /^(#{1,3})\s+/.test(line) ||
    /^\s*([-*_]\s*){3,}$/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line)
  );
}

export function stripMarkdownBlockPrefix(line) {
  return line
    .replace(/^#{1,3}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

function appendCodeBlock(parent, text, lang) {
  const body = text.trim();
  const block = document.createElement("div");
  block.className = "code-block";

  const head = document.createElement("div");
  head.className = "code-head";
  const dot = document.createElement("span");
  dot.className = "code-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "code-lang";
  label.textContent = lang || "code";
  head.append(dot, label);

  // Copy affordance — only when the clipboard API is available, so it never
  // shows a button that silently fails. Copies the raw code body only.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.textContent = "copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(body);
        copy.textContent = "copied";
        copy.classList.add("done");
        setTimeout(() => {
          copy.textContent = "copy";
          copy.classList.remove("done");
        }, 1400);
      } catch {
        copy.textContent = "copy failed";
        setTimeout(() => (copy.textContent = "copy"), 1400);
      }
    });
    head.append(copy);
  }

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = body;
  pre.append(code);
  block.append(head, pre);
  parent.append(block);
}

function appendInlineMarkdown(parent, text, mentions) {
  const tokenPattern = /(\*\*[^*\n][\s\S]*?\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^) \n]+?\)|https?:\/\/[^\s<]+|mailto:[^\s<]+|@[a-z0-9-]+)/gi;
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const index = match.index || 0;
    appendText(parent, text.slice(cursor, index));
    if (value.startsWith("**") && value.endsWith("**")) {
      const strong = document.createElement("strong");
      appendInlineMarkdown(strong, value.slice(2, -2), mentions);
      parent.append(strong);
    } else if (value.startsWith("`") && value.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = value.slice(1, -1);
      parent.append(code);
    } else if (value.startsWith("[") && value.includes("](") && value.endsWith(")")) {
      appendMarkdownLink(parent, value);
    } else if (value.startsWith("@") && mentions && mentions.has(value.slice(1))) {
      const mention = document.createElement("span");
      mention.className = "mention";
      mention.textContent = value;
      parent.append(mention);
    } else if (isSafeHref(value)) {
      const link = document.createElement("a");
      link.href = value;
      link.rel = "noreferrer";
      link.target = "_blank";
      link.textContent = value;
      parent.append(link);
    } else {
      appendText(parent, value);
    }
    cursor = index + value.length;
  }
  appendText(parent, text.slice(cursor));
}

function appendMarkdownLink(parent, value) {
  const match = /^\[([^\]\n]+)\]\(([^) \n]+)\)$/.exec(value);
  if (!match || !isSafeHref(match[2])) {
    appendText(parent, match ? match[1] : value);
    return;
  }
  const link = document.createElement("a");
  link.href = match[2];
  link.rel = "noreferrer";
  link.target = "_blank";
  link.textContent = match[1];
  parent.append(link);
}

function appendText(parent, text) {
  if (text) parent.append(document.createTextNode(text));
}

export function isSafeHref(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}
