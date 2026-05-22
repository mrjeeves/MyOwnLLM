/**
 * Markdown rendering for LLM chat output.
 *
 * Thin wrapper over `marked` so the chat panel has one tiny call site
 * (`renderMarkdown(content)` → HTML string for `{@html …}`). We
 * configure marked once at module load and reuse the same instance.
 *
 * Safety: marked v15+ removed its `sanitize` option and passes raw
 * HTML in the source through verbatim, so we have to neutralise the
 * two attack surfaces ourselves before any output reaches `{@html}`:
 *   1. Raw HTML tokens (both block-level `<div …>` and inline
 *      `<script>`) — converted to text tokens so marked emits them
 *      as escaped text instead of live markup.
 *   2. Link / image URLs whose scheme isn't `http(s):` or `mailto:` —
 *      stripped to plain `[label](url)` text so a clever model can't
 *      smuggle a `javascript:` payload past the renderer.
 *
 * GFM stays on so the user gets tables, strikethrough, autolinks,
 * task lists, and fenced code — the formatting modern chat models
 * actually emit. `breaks: true` turns a single newline into `<br>`
 * so model output wrapped at ~80 cols doesn't collapse into one line.
 */

import { marked, type Token } from "marked";

marked.use({
  gfm: true,
  breaks: true,
  walkTokens: (token: Token) => {
    // Both block-level and inline raw HTML come through as `type:
    // "html"`. Marked renders these as-is by default — that's a
    // straight XSS hole when the source can be model output. Convert
    // to a text token so the renderer escapes `<` / `>` / `&`.
    if (token.type === "html") {
      const t = token as { type: string; text?: string; raw?: string; tokens?: unknown };
      t.type = "text";
      t.text = t.raw ?? t.text ?? "";
      delete t.tokens;
      return;
    }
    if (token.type === "link" || token.type === "image") {
      const t = token as { type: string; href?: string; text?: string; tokens?: unknown };
      const href = t.href ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) {
        // Keep the original `[label](url)` shape visible so the user
        // can see what was attempted, but stop marked from emitting
        // an <a href>.
        t.type = "text";
        t.text = `[${t.text ?? ""}](${href})`;
        delete t.href;
        delete t.tokens;
      }
    }
  },
});

/** Render a markdown string to HTML. Empty / nullish input yields the
 *  empty string so callers don't need to guard. Marked's sync `parse`
 *  is what we want here — we never need async tokenisation. */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  return marked.parse(src, { async: false }) as string;
}
