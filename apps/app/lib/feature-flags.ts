/**
 * Feature flags for controlling application behavior.
 * These must be functions (not constants) to work correctly in Next.js server/client contexts.
 */

/**
 * Returns whether to use mock judges data instead of calling the API.
 * This is a development-only flag and should never be enabled in production.
 *
 * @returns true if NEXT_PUBLIC_USE_MOCK_JUDGES is set to 'true', false otherwise
 */
export function getUseMockJudges(): boolean {
  return process.env.NEXT_PUBLIC_USE_MOCK_JUDGES === "true";
}
