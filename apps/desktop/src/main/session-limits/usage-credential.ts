/**
 * @file usage-credential.ts
 * @description PRD-538 R5 (ISS-5353). Resolves the Claude Code OAuth ACCESS
 * TOKEN used to authenticate the owned `GET /api/oauth/usage` request.
 *
 * ── Which credential source, and why exactly one ──────────────────────────────
 * Claude Code keeps its OAuth credential in one of three places (enumerated in
 * {@link file://../../shared/billing-mode.ts billing-mode.ts}, whose detector
 * reads their EXISTENCE only):
 *
 *   1. `CLAUDE_CODE_OAUTH_TOKEN` — the long-lived token `claude setup-token`
 *      mints for headless/CI use.
 *   2. `<configDir>/.credentials.json` — the plaintext store. The norm on
 *      Linux/WSL, and the macOS fallback when the Keychain is unavailable.
 *   3. The macOS login Keychain, service `Claude Code-credentials` — the
 *      DEFAULT on macOS.
 *
 * This module reads (2) and ONLY (2). The other two are deliberate NON-sources,
 * not an ordered fallback chain — PRD-538 R5 requires picking one source on
 * purpose rather than probing several and taking whichever answers first:
 *
 *   - The Keychain (3) is excluded because reading the SECRET requires
 *     `security find-generic-password -w`, which crosses the item's ACL and
 *     raises a macOS authorization prompt at the user. PRD-538 forbids any
 *     "new OAuth grant, re-authentication, or user-facing auth step", and
 *     {@link file://../cost/anthropic-keychain.ts anthropic-keychain.ts} carries
 *     a standing "Do not add `-w` here" instruction. That instruction is NOT
 *     relaxed by this ticket: the existence-only probe stays existence-only, and
 *     this module does not call it at all.
 *   - `CLAUDE_CODE_OAUTH_TOKEN` (1) is excluded because it is a different
 *     credential CLASS — a long-lived CI token whose presence depends on the
 *     shell that happened to launch Electron. Honoring it would make "which
 *     credential did we read" vary by launch context, and would silently prefer
 *     a CI token over the interactive user's own session.
 *
 * CONSEQUENCE, stated plainly rather than buried: on a DEFAULT macOS install the
 * credential lives in the Keychain, so this resolver returns null and the
 * feature reports unavailable (hidden). That is the ticket's required graceful
 * degradation, not a failure path — but it does mean `/usage` capture covers
 * Linux/WSL installs and macOS installs that fell back to the plaintext file,
 * NOT every macOS install. Widening it needs a product decision about prompting
 * that PRD-538 explicitly withholds.
 *
 * ── Secret handling (non-negotiable) ──────────────────────────────────────────
 * The token is returned to the caller for exactly one purpose: an `Authorization`
 * request header. It is never logged, never interpolated into an error message,
 * never written to the snapshot or any cache artifact, and never returned over
 * IPC. Every failure path returns null carrying NO detail derived from the file
 * contents — a parse failure yields the same bare null as a missing file, so
 * nothing about the credential can leak through an error channel.
 *
 * This module never REFRESHES and never WRITES. An expired access token yields
 * null (→ unavailable) rather than spending the refresh token and rewriting a
 * credential store the CLI owns; mutating that store is out of scope for a
 * read-only capture, and a stale-token 401 already degrades correctly.
 */
import { z } from "zod";

/**
 * The one field we need out of `.credentials.json`, plus the optional expiry.
 *
 * Deliberately NOT `.strict()`: this file is written by a peer program on its
 * own release cadence, so an unknown sibling key is expected and must not
 * invalidate the credential (AGENTS.md cross-repo version-skew rule). Only the
 * fields below are read; everything else is ignored and never copied anywhere.
 */
const credentialsFileValidator = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    /**
     * Epoch MILLISECONDS. Optional because we do not depend on it: it is a
     * cheap pre-check that avoids a request we know will 401. When it is absent
     * or unparseable we simply attempt the request and let the server be the
     * authority, which is why no seconds-vs-milliseconds heuristic is needed.
     */
    expiresAt: z.number().finite().positive().optional(),
  }),
});

/** Injected seam so the resolver is testable without touching a real credential. */
export type UsageCredentialDeps = {
  /** Process environment — read for the config-dir override only. */
  env: Record<string, string | undefined>;
  /** User home directory (e.g. `os.homedir()`). */
  homeDir: string;
  /**
   * Read the credential file as UTF-8, or return null when it does not exist /
   * cannot be read. Must NOT throw and must not surface the OS error, whose
   * message can embed the path.
   */
  readFileText: (path: string) => string | null;
  /** Join path segments (injected so this module needs no `node:path`). */
  joinPath: (...segments: string[]) => string;
  /** Current epoch ms, for the expiry pre-check. */
  now: () => number;
};

/**
 * Resolve the Claude Code config dir, honoring `$CLAUDE_CONFIG_DIR`. Mirrors
 * `claudeConfigDir` in the billing-mode engine so a relocated profile is read
 * from the same place the detector already checks for existence.
 */
function claudeConfigDir(deps: UsageCredentialDeps): string {
  const override = deps.env.CLAUDE_CONFIG_DIR;
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return deps.joinPath(deps.homeDir, ".claude");
}

/**
 * Absolute path of the plaintext credential store this module reads. Exported
 * for tests and for the diagnostics surface, which may state WHICH path was
 * consulted — the path is not sensitive; its contents are.
 */
export function usageCredentialPath(deps: UsageCredentialDeps): string {
  return deps.joinPath(claudeConfigDir(deps), ".credentials.json");
}

/**
 * Read the OAuth access token from `<configDir>/.credentials.json`, or null when
 * it is absent, malformed, or expired.
 *
 * Returns a bare string rather than the parsed record so no call site can
 * accidentally spread the refresh token or any sibling field into a payload.
 */
export function readUsageAccessToken(deps: UsageCredentialDeps): string | null {
  let raw: string | null = null;
  try {
    raw = deps.readFileText(usageCredentialPath(deps));
  } catch {
    return null;
  }
  if (raw === null || raw.length === 0) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    // Never surface the parse error — its message can quote file contents.
    return null;
  }

  const result = credentialsFileValidator.safeParse(parsedJson);
  if (!result.success) {
    // Never surface `result.error` — Zod issues echo the offending input.
    return null;
  }

  const { accessToken, expiresAt } = result.data.claudeAiOauth;
  if (expiresAt !== undefined && expiresAt <= deps.now()) {
    return null;
  }
  return accessToken;
}
