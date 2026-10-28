import {
  DESKTOP_ANONYMOUS_FEATURE_FLAGS_PATH,
  DESKTOP_FEATURE_FLAGS_NODE_UUID_HEADER,
  type DesktopFeatureFlagAssignment,
} from "@repo/api/src/types/desktop-feature-flags";
import { z } from "zod";
import {
  fetchSessionJson,
  type SessionFetchOptions,
  unwrapApiEnvelope,
} from "../util/api-response-utils.js";
import { fetchJsonAndParse } from "../util/fetch-json-and-parse.js";

/**
 * ISS-8024: fetches the signed-in user's per-user PostHog flag assignment from
 * `GET /desktop/feature-flags`, so the renderer gates on the same flags the web
 * app resolves rather than on a parallel local Labs registry.
 *
 * The request is made HERE, in main, and not in the renderer: the renderer's
 * `connect-src` admits no API origin but the replay proxy, and the packaged
 * renderer makes no outbound network requests at all. Auth uses the current
 * first-party desktop session token —
 * never the configured managed API key — so no PostHog credential ships in the
 * desktop bundle.
 *
 * Every transport, response, or schema failure returns `null`, which the
 * renderer treats as UNRESOLVED and therefore CLOSED. A malformed payload must
 * never be read as an assignment.
 */
export type DesktopFeatureFlagsFetchOptions = SessionFetchOptions;

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * STRIPPING, not passing through and not `.strict()`. This object crosses two
 * boundaries — the API response and then IPC to the renderer — and the contract
 * the renderer reads is exactly `{ userId, resolved, flags }`. Passing unknown
 * keys through forwarded whatever the API happened to add (a PostHog key, the
 * distinct ids, provider metadata) into the renderer along with it.
 *
 * `.strict()` would be the wrong correction: a newer API adding an additive
 * optional field would fail the whole parse, and a failed parse here is `null`,
 * which the renderer reads as UNRESOLVED and closes every gate. Zod's default
 * strip drops the extra key and keeps the assignment, which is the
 * degrade-gracefully direction this repo's version-skew rule asks for.
 */
const desktopFeatureFlagAssignmentSchema = z.object({
  userId: z.string(),
  resolved: z.boolean(),
  // Rejects a non-boolean verdict outright rather than coercing it: an
  // unparseable assignment is UNKNOWN, and unknown is closed.
  flags: z.record(z.string(), z.boolean()),
});

export function fetchDesktopFeatureFlags(
  options: DesktopFeatureFlagsFetchOptions
): Promise<DesktopFeatureFlagAssignment | null> {
  return fetchSessionJson(
    options,
    "/desktop/feature-flags",
    desktopFeatureFlagAssignmentSchema,
    {
      headers: { Accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
    }
  );
}

/** What the signed-out read needs; both reads are lazy, like every node_uuid reader. */
export type AnonymousDesktopFeatureFlagsSource = {
  fetch?: typeof fetch;
  getApiOrigin: () => string | undefined;
  getNodeUuid: () => string;
};

let anonymousSource: AnonymousDesktopFeatureFlagsSource | null = null;

/**
 * ISS-11945: published once by the composition root, which owns `node_uuid`
 * and the FEA-2199 egress policy. `null` (an unpackaged launch, or a suite that
 * never wires it) makes every signed-out read resolve `null`, which is CLOSED.
 */
export function publishAnonymousDesktopFeatureFlagsSource(
  source: AnonymousDesktopFeatureFlagsSource | null
): void {
  anonymousSource = source;
}

/**
 * ISS-11945 (ISS-11866 D4): the signed-out read — no credential, keyed by the
 * install's `node_uuid`. The API answers only its allow-listed keys. Every
 * failure resolves `null`, as the authenticated read does.
 */
export function fetchAnonymousDesktopFeatureFlags(): Promise<DesktopFeatureFlagAssignment | null> {
  const source = anonymousSource;
  const apiOrigin = source?.getApiOrigin();
  if (!(source && apiOrigin)) {
    return Promise.resolve(null);
  }
  return fetchJsonAndParse(
    DESKTOP_ANONYMOUS_FEATURE_FLAGS_PATH,
    desktopFeatureFlagAssignmentSchema,
    {
      apiOrigin,
      token: null,
      unwrap: unwrapApiEnvelope,
      sentinel: null,
      headers: {
        Accept: "application/json",
        [DESKTOP_FEATURE_FLAGS_NODE_UUID_HEADER]: source.getNodeUuid(),
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl: source.fetch,
    }
  );
}
