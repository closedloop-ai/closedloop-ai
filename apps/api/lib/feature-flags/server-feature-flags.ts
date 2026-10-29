import { ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY } from "@repo/api/src/types/artifact-status-root-order-flag";
import { ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY } from "@repo/api/src/types/attribution-evidence-policy-flag";
import { COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import { DESKTOP_SESSION_REPLAY_FLAG_KEY } from "@repo/api/src/types/desktop-feature-flags";
import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { DOCUMENT_UNIFIED_COMMENTS_FLAG_KEY } from "@repo/api/src/types/document-unified-comments-flag";
import { ELECTRON_REMOTE_UPDATE_FLAG_KEY } from "@repo/api/src/types/electron-remote-update-flag";
import { PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY } from "@repo/api/src/types/github";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { PENSERO_INTEGRATION_FLAG_KEY } from "@repo/api/src/types/pensero-integration-flag";
import { PENSERO_POINTS_PER_DOLLAR_FLAG_KEY } from "@repo/api/src/types/pensero-points-per-dollar-flag";
import { SESSION_MESH_V1_FEATURE_FLAG_KEY } from "@repo/api/src/types/session-mesh-flag";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import {
  defineGrantFlag,
  defineRestrictionFlag,
  type GrantFeatureFlag,
  type ServerFeatureFlag,
  ServerFeatureFlagKind,
} from "./server-feature-flag";
import {
  type GrantSuppression,
  suppressGrants,
} from "./server-feature-flag-suppression";

/**
 * ISS-7778: every PostHog flag `apps/api` evaluates server-side, each declared
 * WITH what enabling it does.
 *
 * This module is the flags' definition site, not a classification list kept
 * beside them: the key and the kind are one `define*` call, there is no second
 * place a kind could be recorded, and nothing can drift out of agreement with
 * something that does not exist. A key that a client surface also reads is
 * imported from its shared `packages/api/src/types/` owner; a key only this app
 * evaluates is declared here outright, and the module that used to hold the
 * bare string now re-exports `.key` from the definition below.
 *
 * THE REGISTRY IS WHAT MAKES THE CLASSIFICATION EXHAUSTIVE AT COMPILE TIME.
 * {@link RegisteredServerFeatureFlag} is derived from these entries, and it is
 * the only thing `evaluateServerFeatureFlagForDistinctId` accepts — so a flag
 * that is not defined here cannot be evaluated at all, and one defined here
 * cannot exist without a kind. There is no runtime default to fall back to,
 * because there is no runtime path that reaches an unclassified flag.
 *
 * It is also what makes {@link suppressAllGrants} complete: "all grants" is
 * computed from these entries rather than enumerated by hand, so a grant added
 * later is suppressed without anyone remembering to add it, and a restriction
 * added later is not suppressed without anyone remembering to exempt it.
 *
 * WHAT IT DOES NOT REACH, stated so nobody assumes otherwise: the WHOLE-
 * ASSIGNMENT read behind `apps/api/app/desktop/feature-flags/service.ts` returns
 * every key PostHog answers for a principal, straight from
 * `getAllFeatureFlagsForDistinctId`, without passing a key through this registry.
 * Those values gate the desktop shell's UI and make no authorization decision,
 * so they are outside this ticket — but a suppression applied here does not
 * touch them, and a caller that needs it to would have to classify that path
 * too.
 *
 * A RETIRED KEY, recorded here because this registration was its last home:
 * `sessions-displayed-status-parity`. ISS-10629 and ISS-10742 removed its final
 * evaluator; Cosimo Corrigan ruled on 2026-09-22 (ISS-10782) to retire the
 * registration and its `@repo/api` key module rather than hold them for a
 * rollout that is not returning. Re-adding it is a new rollout decision, not a
 * restoration.
 *
 * The PostHog flag itself OUTLIVES that deletion and is tracked by ISS-10953.
 * `ui-flag-attestation-sweep.yml` asks PostHog only about keys this repo ships,
 * so once the registration above is gone nothing here names the key again --
 * archiving it in project 341818 needs a human, and this line is what carries
 * that forward.
 */

/**
 * ON ⇒ a bound desktop-managed API key must prove possession; OFF ⇒ `monitor`,
 * and `verifyDesktopManagedPop` reports `accepted: mode !== "enforce"`, so a
 * FAILED proof-of-possession is accepted. Read on every API-key request through
 * the auth wrapper.
 */
export const DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG =
  defineRestrictionFlag("desktop-managed-pop-enforcement");

/**
 * ON ⇒ automated Desktop managed-key installer provisioning is offered on a
 * supported platform; OFF ⇒ it fails closed and nothing is provisioned.
 *
 * Not in ISS-7778's census of server-evaluated flags — the compile-time gate
 * surfaced it, which is the mechanism doing the job it exists for.
 */
export const DESKTOP_MANAGED_POP_PROVISIONING_SERVER_FLAG = defineGrantFlag(
  "desktop-managed-pop-provisioning"
);

/**
 * RESTRICTION by the operator's ISS-7778 ruling of 2026-09-01: "compute-target-
 * signing is a restriction because disabling it permits unsigned dispatch, and
 * any availability/UI rollout concern must use a separate grant flag."
 *
 * It reads grant-shaped at the first hop — OFF resolves `unsupported`, which
 * `loadFeatureAndOwnerEligibility` reports as `Ineligible` with reason
 * `feature_disabled`, and an "ineligible, feature disabled" result looks like a
 * capability being withheld. It is not. `resolveCommandSigningRequirement` maps
 * that `Ineligible` to `CommandSigningRequirementStatus.NotRequired`, and the
 * commands route treats `NotRequired` as permission to proceed WITHOUT a
 * signature: it signs only on `Required`.
 *
 * So the flag's ENABLED state is what makes browser command signing mandatory on
 * a node that advertises enforcement, and turning it off accepts unsigned
 * dispatch. `Ineligible` names the owner's standing in the signing program, not
 * a capability denied to the caller.
 */
export const COMPUTE_TARGET_SIGNING_SERVER_FLAG = defineRestrictionFlag(
  COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY
);

/** ON ⇒ public GitHub repositories may be connected or merged. */
export const PUBLIC_GITHUB_REPOS_SERVER_FLAG = defineGrantFlag(
  PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY
);

/** ON ⇒ an org admin may write the Pensero credential. */
export const PENSERO_INTEGRATION_SERVER_FLAG = defineGrantFlag(
  PENSERO_INTEGRATION_FLAG_KEY
);

/**
 * ON ⇒ this reader sees Pensero points as the per-dollar numerator, so the
 * branch-detail read fetches one (ISS-9814).
 *
 * The DISPLAY half of the pair whose write half is
 * {@link PENSERO_INTEGRATION_SERVER_FLAG}. Registered server-side so the read
 * can be skipped entirely for a principal who would not render the value —
 * without this the branch-detail route pays for a second interactive
 * transaction on every request for any org in the write rollout, and then
 * discards the result because the client gate is off.
 */
export const PENSERO_POINTS_PER_DOLLAR_SERVER_FLAG = defineGrantFlag(
  PENSERO_POINTS_PER_DOLLAR_FLAG_KEY
);

/**
 * GRANT by the operator's ISS-7778 ruling of 2026-09-01: "classify
 * electron-remote-update as a grant because OFF denies the operation; its
 * fail-open provider behavior remains separate scope."
 *
 * That fail-open behavior is real and is deliberately left alone here:
 * `isElectronRemoteUpdateEnabled` returns true when no analytics client is
 * configured, when the evaluation throws, and for any non-`false` verdict. A
 * suppression still denies the command with a 403, because suppression resolves
 * an explicit `false` rather than an unanswered read.
 */
export const ELECTRON_REMOTE_UPDATE_SERVER_FLAG = defineGrantFlag(
  ELECTRON_REMOTE_UPDATE_FLAG_KEY
);

/** ON ⇒ the branch author may act on a local branch PR; OFF ⇒ 403. */
export const BRANCH_PR_SERVER_FLAG = defineGrantFlag("branch-pr");

/** ON ⇒ the MCP attachment-upload mutation is admitted. */
export const MCP_UPLOAD_ATTACHMENT_SERVER_FLAG = defineGrantFlag(
  "mcp-upload-attachment"
);

/**
 * ISS-12552 (PRD-800 "Rollout"): ON ⇒ the organization records operation
 * receipts and evidence, and Related Sessions, the documents list and a
 * document's Sessions tab classify sessions from operation evidence; OFF ⇒
 * capture and reads as before PRD-800. A company group flag, read per
 * organization and opened in organization rings.
 */
export const ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG = defineGrantFlag(
  ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY
);

/**
 * ON ⇒ agent-component detail attribution reads exclude branches with no
 * evidence they ever reached a remote; OFF ⇒ the pre-ISS-8148 populations.
 */
export const BRANCH_PUSH_EVIDENCE_EXCLUSION_SERVER_FLAG = defineGrantFlag(
  "branch-push-evidence-exclusion"
);

/**
 * ON ⇒ an unverified org-merged population renders as not-yet-measured instead
 * of as the number `0`.
 */
export const UNMEASURED_DELIVERY_POPULATION_SERVER_FLAG = defineGrantFlag(
  "unmeasured-delivery-population"
);

/**
 * ON ⇒ the ISS-8554 TypedSQL shadow COMPARISON runs for this viewer.
 *
 * GRANT because enabling it only ADMITS a capability — a read-only comparison
 * beside the response — so withholding it can only narrow what runs. That is the
 * `Grant` contract in `server-feature-flag.ts`, and it is what makes a blanket
 * `suppressAllGrants` safe here: suppression can stop the shadow, never open a
 * hole.
 *
 * NOT because of fail-closed behaviour. An earlier revision of this comment said
 * the kind gave OFF-when-unavailable; it does not. `createMemoizedFeatureFlagGate`
 * resolves false on an unanswered lookup for EVERY gate, Restriction ones
 * included, and `kind` is read only by `suppressGrants` / `isRegisteredGrant`,
 * never on the evaluation path (api-architect on #6281).
 *
 * Named for running a comparison, not for serving the TypedSQL summary — the
 * cutover gets its own key, because the two decisions have different blast
 * radii.
 *
 * ISS-8554 Phase 3 (PLN-1853 D15/revision 12, operator ruling 2026-10-09):
 * ALSO gates the list-sort shadow (`session-list-sort-shadow.ts`), reusing
 * this key rather than minting a second one — same risk class (Grant,
 * read-only, no response change), and one key is less to track. The
 * consequence, stated rather than hidden: this flag is already at 100%
 * rollout in production (ISS-10909), so the list-sort shadow starts running
 * for every request the moment this ships, with no separate 0%-first
 * verification window of its own.
 */
export const SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG = defineGrantFlag(
  "sessions-usage-typed-sql-shadow"
);

/**
 * ON ⇒ the Branches server page and its Status facet are ordered root-first
 * (ISS-9437); OFF ⇒ today's `Object.values(BranchStatus)` order exactly.
 *
 * GRANT: it can only change the ORDER of rows the caller is already entitled to
 * see. It admits no row, denies no row, and makes no authorization decision, so
 * a blanket `suppressAllGrants` can only return the list to its current order.
 *
 * The response is unchanged either way, which is why this is safe to resolve
 * per request: the same principal gets the same order on every read, and a
 * principal PostHog cannot answer for gets the default.
 */
export const ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG = defineGrantFlag(
  ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY
);

/**
 * ISS-10422 (PRD-714), read server-side by ISS-10472. ON ⇒ a grouped artifact
 * board sections on the RETAINED status evidence rather than the coerced
 * lifecycle value; OFF ⇒ today's sectioning exactly.
 *
 * GRANT, for the same reason as the root-order flag above: it can only change
 * which section a row the caller already sees is drawn under, and the order
 * those sections appear in. It admits no row and denies none, so a blanket
 * `suppressAllGrants` returns the board to its current sectioning.
 *
 * `ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG` takes precedence over this one,
 * matching `useTableViewOrdering`'s own order of checks — the two keys are
 * independent in PostHog and both can be on.
 */
export const UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG = defineGrantFlag(
  UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
);

/**
 * ISS-11073 (ISS-4779 closed-by-default policy). ON ⇒ the guided onboarding
 * snapshot stops accepting the legacy team/project wizard's completion marker
 * as completion of the GUIDED run, and stops asking a reader to create an
 * organization the snapshot's own org scope proves they have; OFF ⇒ today's
 * folds exactly.
 *
 * OFF is the shipped defect: a brand-new organization completes the legacy
 * wizard, `completeWizard` stamps `wizardCompletedAt`, the guided snapshot
 * accepts that marker as the GUIDED run's completion, and Get Started lands on
 * the dashboard tour with invitations never shown or skipped and the Desktop
 * download never offered. ON, the reader reaches invitations and then the
 * download gate before the dashboard, which is the PRD-689 order.
 *
 * NOT a completion claim in either position. The deferred Getting-started
 * checklist stays incomplete until its steps are genuinely done; this gate
 * decides which phases a first run VISITS, never what it is recorded as having
 * finished.
 *
 * DECLARED HERE, not in `packages/api/src/types/`: `apps/api` is the only
 * process that takes this decision and nothing about it crosses a wire, so per
 * this module's own contract above the key belongs at its definition site. A
 * client read added later would move it to a shared owner at that point; one
 * key still serves both shells either way.
 *
 * RESTRICTION, and the first revision of this entry had it wrong (whitlockk on
 * #7854). Reading the phases as a capability ADMITTED is the grant argument, and
 * it does not survive the fact that the phases are BLOCKING: ON keeps the first
 * user OUT of the dashboard-ready phase until invitations and the Desktop
 * download have each been answered, and OFF lets that same reader reach the
 * dashboard having answered neither. Withholding this flag therefore WIDENS what
 * is reachable, which is precisely what {@link ServerFeatureFlagKind.Restriction}
 * names — "withholding it REMOVES that constraint".
 *
 * What the misclassification cost was not hypothetical: `suppressAllGrants` is
 * computed from this registry, so the key was in the blanket with no site naming
 * it. A reviewer of that suppression would have seen a list it does not print
 * and no mention of onboarding anywhere — a required sequence coming off
 * silently. A suppressed grant also resolves an ANSWERED `false` rather than
 * `null` (`evaluateServerFeatureFlagForDistinctId`), so a memoizing gate would
 * hold the suppression rather than re-ask.
 *
 * THE KIND CHANGES NOTHING ABOUT EVALUATION, stated so the closed-by-default
 * reading above still holds: `createMemoizedFeatureFlagGate` resolves `false` on
 * an unanswered lookup for restrictions exactly as for grants, and `kind` is read
 * only by `suppressGrants` / `isRegisteredGrant`, never on the evaluation path.
 * An outage still degrades to today's behaviour. What changes is that
 * `suppressAllGrants` can no longer reach the key, enforced by the type —
 * `RegisteredGrantFeatureFlag` excludes a restriction — and not by a list.
 */
export const WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG =
  defineRestrictionFlag("web-guided-onboarding-required-phases");

/**
 * Every server-evaluated flag, keyed by a stable camelCase name.
 *
 * Adding an entry here is the ONLY way to make a flag evaluable, and `define*`
 * is the only way to build an entry, so classification cannot be skipped or
 * deferred.
 */
export const SESSION_MESH_V1_SERVER_FLAG = defineGrantFlag(
  SESSION_MESH_V1_FEATURE_FLAG_KEY
);

/**
 * ON ⇒ the install records desktop session replay (ISS-11838). Evaluated here
 * only by the unauthenticated, `node_uuid`-keyed
 * `GET /desktop/feature-flags/anonymous` (ISS-11945).
 */
export const DESKTOP_SESSION_REPLAY_SERVER_FLAG = defineGrantFlag(
  DESKTOP_SESSION_REPLAY_FLAG_KEY
);

/**
 * ON ⇒ an internal viewer may operate Dev Mode (ISS-7477). Evaluated here only
 * by ISS-12048's check of whether a request's Dev Tools overrides apply, which
 * is also why it is never itself overridable on the server.
 */
export const DEV_MODE_SERVER_FLAG = defineGrantFlag(DEV_MODE_FLAG_KEY);

/**
 * ON ⇒ the org's document comments are written to Postgres and its Liveblocks
 * room tokens lose comment write access (PLN-2187 T-2.6, T-7.1).
 *
 * RESTRICTION: once an org is switched, withholding the flag from one viewer
 * would send that viewer's comments back to Liveblocks while the rest of the
 * org writes to Postgres, the split brain DD-2 exists to prevent. A Dev Mode
 * override or blanket grant suppression must not be able to reach it.
 */
export const DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG = defineRestrictionFlag(
  DOCUMENT_UNIFIED_COMMENTS_FLAG_KEY
);

/** ON permits manual hierarchy placement reads and writes for this viewer. */
export const MANUAL_ARTIFACT_ORDERING_SERVER_FLAG = defineGrantFlag(
  MANUAL_ARTIFACT_ORDERING_FLAG_KEY
);

export const SERVER_FEATURE_FLAGS = {
  sessionMeshV1: SESSION_MESH_V1_SERVER_FLAG,
  artifactStatusRootOrder: ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG,
  attributionEvidencePolicy: ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
  universalArtifactStatus: UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG,
  branchPr: BRANCH_PR_SERVER_FLAG,
  branchPushEvidenceExclusion: BRANCH_PUSH_EVIDENCE_EXCLUSION_SERVER_FLAG,
  computeTargetSigning: COMPUTE_TARGET_SIGNING_SERVER_FLAG,
  desktopManagedPopEnforcement: DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG,
  desktopManagedPopProvisioning: DESKTOP_MANAGED_POP_PROVISIONING_SERVER_FLAG,
  desktopSessionReplay: DESKTOP_SESSION_REPLAY_SERVER_FLAG,
  devMode: DEV_MODE_SERVER_FLAG,
  documentUnifiedComments: DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG,
  electronRemoteUpdate: ELECTRON_REMOTE_UPDATE_SERVER_FLAG,
  mcpUploadAttachment: MCP_UPLOAD_ATTACHMENT_SERVER_FLAG,
  manualArtifactOrdering: MANUAL_ARTIFACT_ORDERING_SERVER_FLAG,
  penseroIntegration: PENSERO_INTEGRATION_SERVER_FLAG,
  penseroPointsPerDollar: PENSERO_POINTS_PER_DOLLAR_SERVER_FLAG,
  publicGithubRepos: PUBLIC_GITHUB_REPOS_SERVER_FLAG,
  sessionsUsageTypedSqlShadow: SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG,
  unmeasuredDeliveryPopulation: UNMEASURED_DELIVERY_POPULATION_SERVER_FLAG,
  webGuidedOnboardingRequiredPhases:
    WEB_GUIDED_ONBOARDING_REQUIRED_PHASES_SERVER_FLAG,
} as const;

/** The exact PostHog key of every registered server flag. */
export type ServerFeatureFlagKey =
  (typeof SERVER_FEATURE_FLAGS)[keyof typeof SERVER_FEATURE_FLAGS]["key"];

/**
 * A flag that is both classified and registered.
 *
 * The server evaluator accepts nothing else, which is what makes the
 * classification exhaustive: a new flag that has not been defined above is not
 * assignable here, and `tsc` rejects the call rather than a runtime default
 * quietly deciding for it.
 */
export type RegisteredServerFeatureFlag =
  ServerFeatureFlag<ServerFeatureFlagKey>;

/** Each registry entry at its own declared type, kind and literal key intact. */
type RegisteredServerFeatureFlagEntry =
  (typeof SERVER_FEATURE_FLAGS)[keyof typeof SERVER_FEATURE_FLAGS];

/**
 * The registry's GRANT descriptors, as the exact union of the values declared
 * above rather than the open `GrantFeatureFlag<string>`.
 *
 * This is what `suppressGrants` accepts, and the narrowing is load-bearing.
 * `defineGrantFlag` is public and generic over `Key extends string`, so the open
 * type admitted `defineGrantFlag(DESKTOP_MANAGED_POP_ENFORCEMENT_SERVER_FLAG
 * .key)` — a grant-typed value carrying a restriction's key, which membership-
 * only suppression would then honor. Here `desktop-managed-pop-enforcement` is
 * present only as a `RestrictionFeatureFlag`, so no re-declaration of its kind
 * is assignable and the key cannot be separated from its classification.
 */
export type RegisteredGrantFeatureFlag = Extract<
  RegisteredServerFeatureFlagEntry,
  GrantFeatureFlag
>;

/** Every registered flag, in registration order. */
export function listServerFeatureFlags(): readonly RegisteredServerFeatureFlag[] {
  return Object.values(SERVER_FEATURE_FLAGS);
}

/**
 * A blanket suppression of EVERY registered grant.
 *
 * Restrictions are absent because the filter narrows to
 * {@link GrantFeatureFlag} before `suppressGrants` is reached — the same
 * compile-time boundary a hand-written suppression hits, applied to the whole
 * registry at once. A restriction reclassified as a grant would appear here,
 * which is precisely the failure the classification tests assert against.
 */
export function suppressAllGrants(): GrantSuppression {
  const entries: readonly RegisteredServerFeatureFlagEntry[] =
    Object.values(SERVER_FEATURE_FLAGS);
  return suppressGrants(entries.filter(isRegisteredGrant));
}

/**
 * ISS-12048: a suppression of exactly the registered GRANTS among `keys`, for a
 * Dev Mode override to off. A restriction key in `keys` is simply not a grant
 * the filter can return, so it can never be withheld this way.
 */
export function grantSuppressionForKeys(
  keys: ReadonlySet<string>
): GrantSuppression {
  const entries: readonly RegisteredServerFeatureFlagEntry[] =
    Object.values(SERVER_FEATURE_FLAGS);
  return suppressGrants(
    entries.filter(isRegisteredGrant).filter((flag) => keys.has(flag.key))
  );
}

/**
 * Narrows a registry entry to its grant half, PASSING THE ENTRY THROUGH rather
 * than rebuilding one.
 *
 * The predicate replaces a `push({ key: flag.key, kind: Grant })` that
 * reconstructed a descriptor from a key. That reconstruction re-declared the
 * kind for whatever key it was handed, which is the same hole the widened
 * `suppressGrants` parameter had: had the loop guard ever been wrong, it would
 * have minted a grant-typed restriction instead of failing to compile.
 */
function isRegisteredGrant(
  flag: RegisteredServerFeatureFlagEntry
): flag is RegisteredGrantFeatureFlag {
  return flag.kind === ServerFeatureFlagKind.Grant;
}
