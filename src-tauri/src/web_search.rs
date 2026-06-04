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
use reqwest::{Client, StatusCode};
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

/// What `agent_web_search` hands back: the normalized query, the hits, the
/// backend that answered, and — when the result is empty or the response
/// looked off — a plain-language `diagnostic` explaining why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WebSearchOutcome {
    pub query: String,
    pub hits: Vec<WebHit>,
    /// Which backend actually answered: `"ddg"` or `"searxng"`. Surfaced so an
    /// empty result can name its source instead of reading as a generic fail.
    pub backend: String,
    /// Why a result is empty or abnormal — throttling, a genuine no-match, or
    /// markup drift. `None` when hits came back normally.
    pub diagnostic: Option<String>,
}

/// A backend search's raw outcome before `web_search_inner` stamps on the
/// backend name: the hits plus an optional diagnostic for an empty/odd response.
struct BackendResult {
    hits: Vec<WebHit>,
    diagnostic: Option<String>,
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

    // Normalize the backend up front so the dispatch and the reported
    // `backend` agree (any unknown value falls back to the keyless default).
    let backend = match backend.as_deref().unwrap_or("ddg") {
        "searxng" => "searxng",
        _ => "ddg",
    };

    let result = match backend {
        "searxng" => {
            let base = searxng_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("the 'searxng' backend requires a 'searxng_url'"))?;
            search_searxng(&http, base, &query, limit).await?
        }
        _ => search_ddg(&http, &query, limit).await?,
    };

    Ok(WebSearchOutcome {
        query,
        hits: result.hits,
        backend: backend.to_string(),
        diagnostic: result.diagnostic,
    })
}

async fn search_ddg(http: &Client, query: &str, limit: usize) -> Result<BackendResult> {
    let resp = http
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", query)])
        .send()
        .await
        .context("send DuckDuckGo request")?;
    // Don't bail on a non-2xx status. DDG answers a throttled scraper with a
    // 202/403/429 — or even a 200 "anomaly" page — and we want to *explain*
    // that, not throw an opaque error. Read the body and let `classify_ddg`
    // turn whatever came back into a diagnostic.
    let status = resp.status();
    let html = resp.text().await.context("read DuckDuckGo response")?;
    let hits = parse_ddg(&html, limit);
    let diagnostic = classify_ddg(status, &html, &hits);
    Ok(BackendResult { hits, diagnostic })
}

async fn search_searxng(
    http: &Client,
    base: &str,
    query: &str,
    limit: usize,
) -> Result<BackendResult> {
    let url = format!("{}/search", base.trim_end_matches('/'));
    let resp = http
        .get(&url)
        .query(&[("q", query), ("format", "json")])
        .send()
        .await
        .context("send SearXNG request")?;
    // Capture the status and read the body as text first: a misconfigured or
    // erroring SearXNG often replies with an HTML page, which `.json()` would
    // collapse into an opaque parse error instead of an explainable one.
    let status = resp.status();
    let body = resp.text().await.context("read SearXNG response")?;
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let hits = parse_searxng(&value, limit);
    let diagnostic = classify_searxng(status, &value, &hits);
    Ok(BackendResult { hits, diagnostic })
}

/// DuckDuckGo's anti-bot / rate-limit pages don't look like an error to
/// `reqwest` (they can be served with HTTP 200), so we sniff the body for the
/// phrasing DDG uses when it's stalling a scraper.
const DDG_ANTI_BOT_MARKERS: &[&str] = &[
    "anomaly",
    "are you a robot",
    "unfortunately, bots",
    "captcha",
    "challenge",
    "rate limit",
];

/// Phrasing on a *normal* DDG results page that genuinely has no matches.
const DDG_NO_RESULTS_MARKERS: &[&str] = &["no results found", "no more results"];

/// Explain an empty or abnormal DuckDuckGo response in one line, or `None`
/// when `hits` came back normally. Pure (no network) so it's unit-tested.
fn classify_ddg(status: StatusCode, html: &str, hits: &[WebHit]) -> Option<String> {
    if !hits.is_empty() {
        // Results win — an odd status doesn't matter once we have hits.
        return None;
    }
    let lower = html.to_lowercase();
    let throttled = !status.is_success()
        || status.as_u16() == 202
        || DDG_ANTI_BOT_MARKERS.iter().any(|m| lower.contains(m));
    if throttled {
        return Some(format!(
            "DuckDuckGo returned an anti-bot/rate-limit page (HTTP {}, {} bytes) instead of \
             results — usually temporary throttling of a new or shared/datacenter IP. Retry in \
             a moment, or set web_search.backend = \"searxng\" in config.json. Source said: {}",
            status.as_u16(),
            html.len(),
            sample(html),
        ));
    }
    if DDG_NO_RESULTS_MARKERS.iter().any(|m| lower.contains(m)) {
        return Some("DuckDuckGo returned a normal results page with no matches.".to_string());
    }
    // 2xx, no anti-bot phrasing, no no-results marker, yet nothing parsed.
    Some(format!(
        "DuckDuckGo returned HTTP {} ({} bytes) but no results could be parsed — the results \
         markup may have changed. Source head: {}",
        status.as_u16(),
        html.len(),
        sample(html),
    ))
}

/// Explain an empty or abnormal SearXNG response, or `None` when results came
/// back. `value` is `Value::Null` when the body wasn't JSON. Pure (no network).
fn classify_searxng(status: StatusCode, value: &Value, hits: &[WebHit]) -> Option<String> {
    if !hits.is_empty() {
        return None;
    }
    if !status.is_success() {
        return Some(format!(
            "SearXNG returned HTTP {} — check that searxng_url points at a reachable instance.",
            status.as_u16(),
        ));
    }
    if value.is_null() {
        return Some(
            "SearXNG returned a non-JSON response — is searxng_url correct and the JSON format \
             enabled on the instance?"
                .to_string(),
        );
    }
    if value.get("results").and_then(Value::as_array).is_none() {
        return Some(
            "SearXNG returned JSON with no 'results' array — unexpected response shape; check \
             the instance and searxng_url."
                .to_string(),
        );
    }
    Some("SearXNG returned 0 results for the query.".to_string())
}

/// A short, readable slice of a source response for diagnostics: tags and
/// entities stripped (via `clean`), whitespace collapsed, and capped so a
/// whole error page can't balloon the chat context.
fn sample(html: &str) -> String {
    const MAX: usize = 200;
    let one_line = clean(html).split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() {
        return "(empty response body)".to_string();
    }
    if one_line.chars().count() > MAX {
        let head: String = one_line.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        one_line
    }
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

    #[test]
    fn classify_ddg_none_when_hits_present() {
        let hits = vec![WebHit {
            title: "x".into(),
            url: "https://x.com".into(),
            snippet: String::new(),
        }];
        // A junk status is irrelevant once we actually have results.
        assert_eq!(classify_ddg(StatusCode::FORBIDDEN, "whatever", &hits), None);
    }

    #[test]
    fn classify_ddg_flags_anti_bot_body_on_200() {
        let note = classify_ddg(
            StatusCode::OK,
            "<p>Our systems detected an anomaly</p>",
            &[],
        )
        .expect("anti-bot body should produce a diagnostic");
        assert!(note.to_lowercase().contains("anti-bot"), "got: {note}");
        assert!(
            note.contains("searxng"),
            "should suggest the fallback: {note}"
        );
    }

    #[test]
    fn classify_ddg_flags_202_as_throttle() {
        let note = classify_ddg(StatusCode::ACCEPTED, "", &[]).expect("202 is suspicious");
        assert!(note.contains("202"), "should name the status: {note}");
        assert!(note.to_lowercase().contains("rate-limit"), "got: {note}");
    }

    #[test]
    fn classify_ddg_reports_http_error_status() {
        let note = classify_ddg(StatusCode::TOO_MANY_REQUESTS, "<html>nope</html>", &[]).unwrap();
        assert!(note.contains("429"), "got: {note}");
    }

    #[test]
    fn classify_ddg_genuine_no_match() {
        let note =
            classify_ddg(StatusCode::OK, "<div>No results found for blah</div>", &[]).unwrap();
        assert!(note.contains("no matches"), "got: {note}");
    }

    #[test]
    fn classify_ddg_unparseable_is_markup_drift() {
        // 2xx, no anti-bot phrasing, no no-results marker, nothing parsed.
        let note = classify_ddg(
            StatusCode::OK,
            "<html><body><span>hi</span></body></html>",
            &[],
        )
        .unwrap();
        assert!(note.contains("markup may have changed"), "got: {note}");
    }

    #[test]
    fn classify_searxng_covers_each_case() {
        // Non-2xx status.
        let s = classify_searxng(StatusCode::BAD_GATEWAY, &Value::Null, &[]).unwrap();
        assert!(s.contains("502"), "got: {s}");
        // 200 but a non-JSON body (parsed to Null).
        let s = classify_searxng(StatusCode::OK, &Value::Null, &[]).unwrap();
        assert!(s.to_lowercase().contains("non-json"), "got: {s}");
        // Valid JSON, empty results array.
        let s = classify_searxng(StatusCode::OK, &json!({ "results": [] }), &[]).unwrap();
        assert!(s.contains("0 results"), "got: {s}");
        // Valid JSON, no results array at all.
        let s = classify_searxng(StatusCode::OK, &json!({ "error": "boom" }), &[]).unwrap();
        assert!(s.contains("results"), "got: {s}");
        // Hits present → no diagnostic.
        let hits = vec![WebHit {
            title: "t".into(),
            url: "https://t.com".into(),
            snippet: String::new(),
        }];
        assert_eq!(classify_searxng(StatusCode::OK, &Value::Null, &hits), None);
    }
}
