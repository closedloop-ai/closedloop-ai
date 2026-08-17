import { CheckSeverity } from "@closedloop-ai/loops-api/compute-target";

/**
 * The ClosedLoop user-plugin set, mirrored for tests.
 *
 * `CLOSEDLOOP_USER_PLUGINS` in `src/server/operations/health-check.ts` is
 * module-private, so suites that assert on plugin checks have to restate it.
 * They restate it HERE, once: two suites previously carried their own copy and
 * the copies had already drifted out of order relative to each other and to
 * production, which is exactly the failure mode a single fixture prevents.
 *
 * Order matches the production constant. If production changes, this fixture is
 * the one place to follow it.
 */
export const CLOSEDLOOP_PLUGINS = [
  { folder: "code", key: "code@closedloop-ai", label: "Symphony Plugin" },
  {
    folder: "platform",
    key: "platform@closedloop-ai",
    label: "Platform Plugin",
  },
  { folder: "judges", key: "judges@closedloop-ai", label: "Judges Plugin" },
  {
    folder: "code-review",
    key: "code-review@closedloop-ai",
    label: "Code Review Plugin",
  },
  {
    folder: "self-learning",
    key: "self-learning@closedloop-ai",
    label: "Self-Learning Plugin",
  },
] as const;

export type ClosedloopPluginKey = (typeof CLOSEDLOOP_PLUGINS)[number]["key"];

export const PLUGIN_KEYS: ClosedloopPluginKey[] = CLOSEDLOOP_PLUGINS.map(
  (plugin) => plugin.key
);

/**
 * The `error` string `manifestUnavailableResult()` stamps on a plugin check when
 * the manifest could not be read (network failure, unparseable JSON, missing
 * marketplace checkout). Asserting on this — rather than on `Array.isArray` —
 * is what distinguishes "the manifest-unavailable branch ran" from "the
 * function returned, as it always does".
 */
export const MANIFEST_UNAVAILABLE_ERROR = "Could not verify latest version";

/**
 * Assert that a plugin check landed on the manifest-unavailable branch.
 *
 * Kept in ONE place because the semantics have already moved once: ISS-5369
 * ("stop System Check asserting failures it has no evidence for") flipped this
 * result from `passed: false` to `passed: true` with
 * `severity: CheckSeverity.Unknown` — an unverifiable manifest is now explicitly
 * NOT a proven failure. Suites that hand-rolled `passed === false` had to be
 * corrected; a single helper means the next such ruling touches one line.
 *
 * Throws rather than asserting, so biome's `noMisplacedAssertion` stays happy.
 */
export function assertManifestUnavailable(check: {
  id: string;
  passed: boolean;
  error?: string;
  severity?: string;
}): void {
  if (check.error !== MANIFEST_UNAVAILABLE_ERROR) {
    throw new Error(
      `${check.id}: expected error ${JSON.stringify(MANIFEST_UNAVAILABLE_ERROR)}, got ${JSON.stringify(check.error)}`
    );
  }
  if (check.severity !== CheckSeverity.Unknown) {
    throw new Error(
      `${check.id}: expected severity ${CheckSeverity.Unknown}, got ${String(check.severity)}`
    );
  }
  if (check.passed !== true) {
    throw new Error(
      `${check.id}: an unverifiable manifest must not be reported as a proven failure (ISS-5369); expected passed=true, got ${String(check.passed)}`
    );
  }
}

/** The passing plugin rows a healthy `runHealthCheck` is expected to emit. */
export function makePassingPluginChecks(): Array<{
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
}> {
  return CLOSEDLOOP_PLUGINS.map((plugin) => ({
    id: `plugin-${plugin.folder}`,
    label: plugin.label,
    required: true,
    passed: true,
  }));
}
