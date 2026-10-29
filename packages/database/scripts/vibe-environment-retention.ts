import { normalizePreviewSchemaName } from "../schema-utils";

export const vibeBranchPrefix = "vibe/" as const;

const vibeSchemaPrefix = schemaPrefixOf(vibeBranchPrefix);

/** ISS-12135: the owner-directed retention policy follows the branch. */
export function isVibeEnvironmentBranch(
  branch: string | null | undefined
): boolean {
  return branch?.startsWith(vibeBranchPrefix) === true;
}

/**
 * Without branch provenance, normalization cannot distinguish vibe/ from
 * lookalikes. Keep candidates for explicit cleanup even before a marker exists.
 */
export function isVibeEnvironmentSchema(
  schemaName: string,
  branch: string | null | undefined
): boolean {
  return matchesEnvironmentSchema(
    schemaName,
    branch,
    vibeBranchPrefix,
    vibeSchemaPrefix
  );
}

/**
 * Perrin Upcott, 2026-10-09, ISS-12214: "Prefix only: vibe/, prototype/, and
 * functional-prototype/". The two prototype lanes' schemas are kept like a
 * vibe environment's. Preview-schema cleanup (the sweep and the PR-close
 * webhook) and unattended migration recovery read these, through
 * {@link isRetainedEnvironmentSchema}; the rest of the vibe build path stays
 * keyed on `vibe/`.
 * scripts/ci/prototype-pin-alias.ts keeps its own copies of the literals, and
 * so does apps/prototypes/scripts/skip-ci.js, whose build allowlist
 * scripts/deploy/vercel-branch-deployment-policy.test.ts holds to this set
 * (ISS-12353).
 */
export const PrototypeBranchPrefix = {
  Prototype: "prototype/",
  FunctionalPrototype: "functional-prototype/",
} as const;

const prototypeBranchPrefixes = Object.values(PrototypeBranchPrefix);

const prototypeSchemaPrefixes = prototypeBranchPrefixes.map(
  (branchPrefix) => [branchPrefix, schemaPrefixOf(branchPrefix)] as const
);

/** The prototype-lane counterpart of {@link isVibeEnvironmentBranch}. */
export function isPrototypeEnvironmentBranch(
  branch: string | null | undefined
): boolean {
  return prototypeBranchPrefixes.some(
    (branchPrefix) => branch?.startsWith(branchPrefix) === true
  );
}

/** The prototype-lane counterpart of {@link isVibeEnvironmentSchema}, lookalikes included. */
export function isPrototypeEnvironmentSchema(
  schemaName: string,
  branch: string | null | undefined
): boolean {
  return prototypeSchemaPrefixes.some(([branchPrefix, schemaPrefix]) =>
    matchesEnvironmentSchema(schemaName, branch, branchPrefix, schemaPrefix)
  );
}

function schemaPrefixOf(branchPrefix: string): string {
  const normalizedRoot = normalizePreviewSchemaName(branchPrefix);
  return normalizedRoot.slice(0, normalizedRoot.lastIndexOf("_") + 1);
}

function matchesEnvironmentSchema(
  schemaName: string,
  branch: string | null | undefined,
  branchPrefix: string,
  schemaPrefix: string
): boolean {
  return branch === null || branch === undefined
    ? schemaName.startsWith(schemaPrefix)
    : branch.startsWith(branchPrefix);
}

/**
 * ISS-12135 and ISS-12214: no automatic path removes these schemas: not the
 * sweep, the PR-close webhook, or unattended migration recovery. Without a
 * registry branch, normalization cannot distinguish vibe/, prototype/ or
 * functional-prototype/ from lookalikes, so those candidates are kept for
 * explicit manual cleanup, including creation residue that has not acquired
 * an environment marker.
 */
export function isRetainedEnvironmentSchema(
  schemaName: string,
  branch: string | null | undefined
): boolean {
  return (
    isVibeEnvironmentSchema(schemaName, branch) ||
    isPrototypeEnvironmentSchema(schemaName, branch)
  );
}
