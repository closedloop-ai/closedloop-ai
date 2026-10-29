// ISS-4965: synthetic, secret-SHAPED values for the definition-content
// redaction suites in this package, `apps/desktop` and `apps/api`. Assembled
// from parts so no scanner reads them as live credentials; none is real.

/** Matches the GitHub-token family; `redactSecrets` writes `[REDACTED:ghp]`. */
export const SYNTHETIC_GITHUB_TOKEN = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}0000`;

/**
 * Matches the Google OAuth access-token family. Its 15 characters become the
 * 29-character `[REDACTED:google_oauth_token]`, so it is the fixture for a
 * marker that is longer than the token it replaces.
 */
export const SYNTHETIC_GOOGLE_TOKEN = `ya29.${"Synthetic0"}`;
