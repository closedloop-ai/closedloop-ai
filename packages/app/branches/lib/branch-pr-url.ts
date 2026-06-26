/**
 * Canonical GitHub PR URL guard (Epic B / B3 + B5c hardening).
 *
 * `pr_url` is persisted local data that can originate from parsed session text
 * (the desktop artifact-ref extractor scans tool output), so it must be treated
 * as untrusted before it is rendered as an `href` or handed to `window.open`:
 * a `javascript:`/`data:` scheme is an XSS vector and an off-domain `https`
 * link is a phishing vector. We allow ONLY a canonical GitHub PR URL —
 * `https://github.com/{owner}/{repo}/pull/{number}` — and otherwise render the
 * non-interactive affordance / disable the action.
 */

// `/{owner}/{repo}/pull/{number}` with an optional trailing path (e.g. `/files`).
const GITHUB_PR_PATH_RE = /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/[^?#]*)?$/;

/** True only for a canonical `https://github.com/.../pull/N` URL. */
export function isGithubPrUrl(url: string | null | undefined): url is string {
  if (!url) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "github.com" &&
    GITHUB_PR_PATH_RE.test(parsed.pathname)
  );
}
