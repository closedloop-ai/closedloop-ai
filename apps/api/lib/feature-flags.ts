/**
 * Feature flags for controlling API behavior.
 * These must be functions (not constants) to work correctly in Next.js server contexts.
 */

/**
 * Returns whether to use mock judges data from local file instead of GitHub Actions.
 * This is a development-only flag and should never be enabled in production.
 *
 * @returns true if USE_MOCK_JUDGES is set to 'true', false otherwise
 */
export function getUseMockJudges(): boolean {
  return process.env.USE_MOCK_JUDGES === "true";
}
