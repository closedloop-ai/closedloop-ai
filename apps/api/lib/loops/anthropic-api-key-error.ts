/**
 * Typed launch failure for the one Cloud-specific precondition the loop
 * orchestrator enforces: an Anthropic API key must be resolvable for the loop
 * owner (user key first, then org key).
 *
 * Cloud loops run on ECS with a server-resolved key, so when no key is
 * configured the launch cannot proceed. Without a distinct type this surfaced
 * as a generic `launch_failed`, whose user-facing copy blames a disconnected
 * desktop app — actively misleading for a Cloud run, which has no desktop app
 * in the picture at all.
 */
export class MissingAnthropicApiKeyError extends Error {
  constructor() {
    super(
      "No Anthropic API key configured. Set a key at the user or organization level."
    );
    this.name = "MissingAnthropicApiKeyError";
  }
}

/** Narrows an unknown launch failure to the missing-key case. */
export function isMissingAnthropicApiKeyError(
  error: unknown
): error is MissingAnthropicApiKeyError {
  return error instanceof MissingAnthropicApiKeyError;
}
