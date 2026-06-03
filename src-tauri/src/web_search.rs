//! Backend for the agent loop's `web_search` tool — keyless web search
//! with a configurable backend.
//!
//! Ported from Myo's native `web_search` tool so MyOwnLLM's agent gains
//! the same look-it-up-on-the-web capability. Two backends: DuckDuckGo's
//! keyless HTML endpoint (the default — works anywhere, no API key) and a
//! self-hosted SearXNG instance's JSON API (cleaner results when you run
//! one). Both return a small list of [`WebHit`]s the `web_search` tool
//! formats for the model.
//!
//! It lives in Rust (behind a Tauri command) rather than in the WebView
//! for the same reason `agent_io`'s shell/file tools do: the fetch has to
//! happen outside the browser sandbox. Scraping `html.duckduckgo.com`
//! from the WebView would trip CORS; reqwest here has no such limit and
//! can send the browser-ish User-Agent DDG expects.
//!
//! The DDG path scrapes HTML, which is inherently a bit brittle; parsing
//! is isolated in [`parse_ddg`] (with fixture tests) so tracking a markup
//! change is a one-function edit, and SearXNG is the robust alternative
//! when that matters.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

/// Default number of results when the model doesn't ask for a count.
const DEFAULT_LIMIT: u64 = 5;
/// Hard ceiling on results per call, so a confused model can't ask for a
/// thousand hits and balloon the chat context.
const MAX_LIMIT: u64 = 10;

/// One search result. Serialized to TS so the `web_search` tool can shape
/// the model-facing text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WebHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// What `agent_web_search` hands back: the normalized query and the hits.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WebSearchOutcome {
    pub query: String,
    pub hits: Vec<WebHit>,
}

/// Run a web search and return up to `limit` hits.
///
/// `backend` selects the engine: `"ddg"` (default, keyless DuckDuckGo) or
/// `"searxng"` (requires `searxng_url`). The TS `web_search` tool passes
/// the user's configured backend; both default cleanly so search works
/// out of the box with no setup.
#[tauri::command]
pub async fn agent_web_search(
    query: String,
    limit: Option<u64>,
    backend: Option<String>,
    searxng_url: Option<String>,
) -> Result<WebSearchOutcome, String> {
    web_search_inner(query, limit, backend, searxng_url)
        .await
        .map_err(|e| e.to_string())
}

async fn web_search_inner(
    query: String,
    limit: Option<u64>,
    backend: Option<String>,
    searxng_url: Option<String>,
) -> Result<WebSearchOutcome> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(anyhow!("web_search requires a non-empty 'query'"));
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;

    // A browser-ish UA is required for DDG to serve real results, and the
    // timeouts keep a hung endpoint from parking the agent loop.
    let http = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0")
        .build()
        .context("build web-search HTTP client")?;

    let hits = match backend.as_deref().unwrap_or("ddg") {
        "searxng" => {
            let base = searxng_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("the 'searxng' backend requires a 'searxng_url'"))?;
            search_searxng(&http, base, &query, limit).await?
        }
        // "ddg" and any unknown value fall back to the keyless default.
        _ => search_ddg(&http, &query, limit).await?,
    };

    Ok(WebSearchOutcome { query, hits })
}

async fn search_ddg(http: &Client, query: &str, limit: usize) -> Result<Vec<WebHit>> {
    let resp = http
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", query)])
        .send()
        .await
        .context("send DuckDuckGo request")?;
    if !resp.status().is_success() {
        return Err(anyhow!("web search failed (HTTP {})", resp.status()));
    }
    let html = resp.text().await.context("read DuckDuckGo response")?;
    Ok(parse_ddg(&html, limit))
}

async fn search_searxng(
    http: &Client,
    base: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<WebHit>> {
    let url = format!("{}/search", base.trim_end_matches('/'));
    let resp = http
        .get(&url)
        .query(&[("q", query), ("format", "json")])
        .send()
        .await
        .context("send SearXNG request")?;
    if !resp.status().is_success() {
        return Err(anyhow!("web search failed (HTTP {})", resp.status()));
    }
    let v: Value = resp.json().await.context("parse SearXNG JSON")?;
    Ok(parse_searxng(&v, limit))
}

/// Pull hits out of a SearXNG JSON response (`results[]` of `{title,url,content}`).
fn parse_searxng(v: &Value, limit: usize) -> Vec<WebHit> {
    v.get("results")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let url = r.get("url").and_then(Value::as_str)?.to_string();
                    let title = r
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let snippet = r
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    Some(WebHit {
                        title,
                        url,
                        snippet,
                    })
                })
                .take(limit)
                .collect()
        })
        .unwrap_or_default()
}

/// Scrape hits out of a DuckDuckGo HTML results page. The stable markers are the
/// `result__a` result anchor (title + a `uddg=`-wrapped redirect href) and the
/// `result__snippet` element. Tolerant: anything it can't parse is skipped.
fn parse_ddg(html: &str, limit: usize) -> Vec<WebHit> {
    let mut hits = Vec::new();
    // Walk each result anchor. The class attribute can carry extra classes, so we
    // match on the marker substring rather than an exact attribute value.
    let mut rest = html;
    while let Some(pos) = rest.find("result__a") {
        rest = &rest[pos..];
        // href="..." appears just before the class on the same <a>; search a small
        // window backwards isn't simple on &str, so instead grab the href that
        // follows within this anchor's tag by scanning forward from the tag start.
        // The anchor opens at the nearest '<' before our marker.
        let tag_start = html[..html.len() - rest.len()].rfind('<').unwrap_or(0);
        let after_tag = &html[tag_start..];
        let href = extract_attr(after_tag, "href=\"");
        let title_raw = extract_between(after_tag, ">", "</a>");
        // Advance past this anchor so the loop makes progress.
        rest = &rest["result__a".len()..];

        let (Some(href), Some(title_raw)) = (href, title_raw) else {
            continue;
        };
        let url = decode_ddg_href(&href);
        if url.is_empty() {
            continue;
        }
        let title = clean(&title_raw);
        // The snippet follows the anchor; look for the next snippet marker in the
        // remaining tail and pull its text.
        let snippet = find_after(after_tag, "result__snippet")
            .and_then(|tail| {
                extract_between(tail, ">", "</a>").or_else(|| extract_between(tail, ">", "</div>"))
            })
            .map(|s| clean(&s))
            .unwrap_or_default();

        hits.push(WebHit {
            title,
            url,
            snippet,
        });
        if hits.len() >= limit {
            break;
        }
    }
    hits
}

/// The value of `attr` (e.g. `href="`) in `s`, up to the closing quote.
fn extract_attr(s: &str, attr: &str) -> Option<String> {
    let start = s.find(attr)? + attr.len();
    let tail = &s[start..];
    let end = tail.find('"')?;
    Some(tail[..end].to_string())
}

/// The text between the first `open` and the following `close` in `s`.
fn extract_between(s: &str, open: &str, close: &str) -> Option<String> {
    let start = s.find(open)? + open.len();
    let tail = &s[start..];
    let end = tail.find(close)?;
    Some(tail[..end].to_string())
}

/// The slice of `s` starting at the first occurrence of `marker` (inclusive),
/// for chained extraction.
fn find_after<'a>(s: &'a str, marker: &str) -> Option<&'a str> {
    s.find(marker).map(|p| &s[p..])
}

/// Turn a DDG result href into a real URL. DDG wraps targets as
/// `//duckduckgo.com/l/?uddg=<percent-encoded-url>&...`; pull and decode it.
/// A non-wrapped absolute href is returned as-is.
fn decode_ddg_href(href: &str) -> String {
    if let Some(idx) = href.find("uddg=") {
        let tail = &href[idx + "uddg=".len()..];
        let enc = tail.split('&').next().unwrap_or(tail);
        return percent_decode(enc);
    }
    if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href.to_string()
    }
}

/// Minimal percent-decoding (`%XX` → byte, `+` → space), enough for the `uddg`
/// target. Invalid escapes are left verbatim.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strip HTML tags and decode the handful of entities DDG emits, then trim.
fn clean(s: &str) -> String {
    let mut no_tags = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => no_tags.push(c),
            _ => {}
        }
    }
    no_tags
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn percent_decode_basics() {
        assert_eq!(percent_decode("https%3A%2F%2Fa.com%2Fx"), "https://a.com/x");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[test]
    fn clean_strips_tags_and_entities() {
        assert_eq!(clean("<b>Rust</b> &amp; you"), "Rust & you");
        assert_eq!(clean("  spaced &#x27;quote&#x27;  "), "spaced 'quote'");
    }

    #[test]
    fn decode_ddg_href_unwraps_uddg() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F&rut=abc";
        assert_eq!(decode_ddg_href(href), "https://www.rust-lang.org/");
        assert_eq!(decode_ddg_href("//example.com/x"), "https://example.com/x");
    }

    #[test]
    fn parse_ddg_extracts_hits_from_fixture() {
        // A trimmed shape of DDG's HTML results markup.
        let html = r#"
        <div class="result results_links">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F">The <b>Rust</b> Language</a>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F">A language empowering everyone.</a>
        </div>
        <div class="result results_links">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust-lang.org%2F">Rust Docs</a>
          <a class="result__snippet" href="x">The official docs &amp; book.</a>
        </div>
        "#;
        let hits = parse_ddg(html, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://www.rust-lang.org/");
        assert_eq!(hits[0].title, "The Rust Language");
        assert_eq!(hits[0].snippet, "A language empowering everyone.");
        assert_eq!(hits[1].url, "https://doc.rust-lang.org/");
        assert_eq!(hits[1].snippet, "The official docs & book.");
    }

    #[test]
    fn parse_ddg_respects_limit() {
        let html = r#"
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com">A</a>
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com">B</a>
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fc.com">C</a>
        "#;
        assert_eq!(parse_ddg(html, 2).len(), 2);
    }

    #[test]
    fn parse_searxng_reads_results() {
        let v = json!({
            "results": [
                { "title": "A", "url": "https://a.com", "content": "first" },
                { "title": "B", "url": "https://b.com", "content": "second" }
            ]
        });
        let hits = parse_searxng(&v, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[1].url, "https://b.com");
        assert_eq!(hits[0].snippet, "first");
    }

    #[tokio::test]
    async fn empty_query_is_rejected() {
        assert!(web_search_inner("   ".into(), None, None, None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn searxng_backend_requires_a_url() {
        let err = web_search_inner("rust".into(), None, Some("searxng".into()), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("searxng_url"), "got: {err}");
    }
}
