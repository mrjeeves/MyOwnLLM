/**
 * Tiny block-and-inline markdown renderer for LLM chat output.
 *
 * Intentionally minimal — handles the formatting models actually emit
 * in chat replies (fenced code, inline code, bold, italic, headings,
 * lists, links, paragraphs) and nothing else. Anything that isn't a
 * recognised construct falls through as escaped plain text, so the
 * output is always safe to drop into the DOM via `{@html}`.
 *
 * Two-stage flow:
 *   1. Block pass walks lines, recognising fenced code blocks, ATX
 *      headings, ordered / unordered lists, and otherwise grouping
 *      consecutive non-blank lines into paragraphs.
 *   2. Inline pass runs per-block on text content: pulls inline code
 *      out behind placeholders first (so * and _ inside backticks
 *      don't trigger emphasis), escapes the rest, then applies bold,
 *      italic, and link rules.
 *
 * HTML escaping is mandatory — every raw character that lands in the
 * output goes through `escapeHtml`, and code-block / link-URL inputs
 * are escaped before substitution. Don't add a rule that emits any
 * unescaped substring of the source.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Apply inline markdown rules to a single block of text.
 *  Inline code is extracted FIRST behind a placeholder so its
 *  contents don't get mangled by the bold/italic regexes; everything
 *  else is escaped, transformed, then the code spans are spliced
 *  back in. */
function renderInline(text: string): string {
  const codes: string[] = [];
  // Pull inline code out first. The placeholder uses \x01 + index +
  // \x01 — a byte we'll never see in real prose and that escapeHtml
  // leaves untouched.
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(escapeHtml(code));
    return `\x01${codes.length - 1}\x01`;
  });
  s = escapeHtml(s);
  // Bold first, then italic — bold uses doubled markers so it has to
  // win the longer match before italic gets to nibble.
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^\n_]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^\n*]+?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^\n_]+?)_(?!\w)/g, "$1<em>$2</em>");
  // Links: only http(s) / mailto — refuse javascript: and other
  // schemes so a clever model can't smuggle script execution past
  // the inline rules.
  s = s.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (match, label: string, url: string) => {
    if (!/^(https?:|mailto:)/i.test(url)) return match;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\x01(\d+)\x01/g, (_, i) => `<code>${codes[Number(i)] ?? ""}</code>`);
  return s;
}

/** Render a markdown string to safe HTML. Empty input yields the
 *  empty string so callers don't have to guard. */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block. Opening fence captures the optional info
    // string; everything up to the next ``` (or EOF) is verbatim
    // code. No language-aware highlighting — we just stash the lang
    // as a data-attribute so callers can style later if they want.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // ATX heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Unordered list — consecutive `- ` / `* ` / `+ ` lines
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list — consecutive `1. ` / `2. ` lines (numbering
    // doesn't have to be sequential, browsers handle that).
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blank line — paragraph separator, skip.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block-starter
    // lines and join them with <br> so a model that wraps its prose
    // keeps the line breaks the user can see.
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === "") break;
      if (/^```/.test(cur)) break;
      if (/^#{1,6}\s/.test(cur)) break;
      if (/^\s*[-*+]\s+/.test(cur)) break;
      if (/^\s*\d+\.\s+/.test(cur)) break;
      paraLines.push(cur);
      i += 1;
    }
    out.push(`<p>${paraLines.map(renderInline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
