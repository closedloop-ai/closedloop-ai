import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level.ts";
import { RECOMMENDED_DATA_SYNC_LEVEL } from "@repo/api/src/types/data-sync-level.ts";
import type { DesktopBootstrapOrganizationRequest } from "@repo/api/src/types/desktop-bootstrap.ts";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity.ts";
import type { OnboardingAccountOutcome } from "@repo/api/src/types/onboarding-analytics.ts";
import type { BinaryPaths } from "./cli-binary-tools.js";

export const DEFAULT_GATEWAY_PORT = 19_432;
export const FALLBACK_GATEWAY_PORTS = [19_433, 19_434, 19_435] as const;
export const PORT_PROBE_ORDER = [
  DEFAULT_GATEWAY_PORT,
  ...FALLBACK_GATEWAY_PORTS,
] as const;
export const GATEWAY_PROTOCOL_VERSION = "0.1.0";

/** Fixed loopback port for the local Agent Dashboard hook listener. */
export const AGENT_MONITOR_PORT = 4820;

export const AgentMonitorHooksWarningCode = {
  CodexOtelConflict: "codex_otel_conflict",
  CodexOtelReceiverUnavailable: "codex_otel_receiver_unavailable",
  CodexOtelWriteFailed: "codex_otel_write_failed",
  CodexOtelUninstallFailed: "codex_otel_uninstall_failed",
  CodexOtelUninstallSkipped: "codex_otel_uninstall_skipped",
} as const;
export type AgentMonitorHooksWarningCode =
  (typeof AgentMonitorHooksWarningCode)[keyof typeof AgentMonitorHooksWarningCode];

export type AgentMonitorHooksWarning = {
  code: AgentMonitorHooksWarningCode;
  path: string;
  message: string;
};

export type AgentMonitorHooksResult = {
  ok: boolean;
  enabled: boolean;
  error?: string;
  warnings?: AgentMonitorHooksWarning[];
};

export type SaveConfigPayload = {
  id?: string;
  name?: string;
  relayOrigin?: string;
  apiOrigin?: string;
  webAppOrigin?: string;
  apiKey?: string;
  /**
   * FEA-4005: optional per-profile sandbox base directory. Omitted when the
   * profile keeps the global sandbox; normalized + risky-root-validated in the
   * main process before it is persisted on the profile.
   */
  sandboxBaseDirectory?: string;
};

/**
 * Read a process env override without referencing the bare `process` global.
 * This file is shared between the Electron main process (Node, where the
 * overrides apply) and the renderer's type program (DOM-only tsconfig with no
 * node types). Going through `globalThis` keeps it type-checkable in both; in
 * the renderer `process` is absent so the literal fallbacks are used.
 */
const readEnvOverride = (name: string): string | undefined =>
  (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env?.[name];

/** WebSocket relay host — the electron app connects here for cloud commands, not the REST API. */
export const DEFAULT_RELAY_ORIGIN =
  readEnvOverride("CL_RELAY_ORIGIN") ?? "https://relay.closedloop.ai";
export const DEFAULT_WEB_APP_ORIGIN =
  readEnvOverride("CL_WEB_APP_ORIGIN") ?? "https://app.closedloop.ai";
/**
 * Additional first-party web-app origins the gateway trusts for browser
 * (health-probe / command) requests alongside the primary `webAppOrigin`.
 * The stage web app (`app.stage.example`) probes the local gateway's
 * `/health` endpoint the same way prod does, but the gateway's CORS allowlist only
 * matched the single configured `webAppOrigin` (prod), so the stage probe was
 * CORS-blocked. Additive and forward-compatible: unknown origins still fall
 * through to the existing prod-origins-only / loopback gates.
 */
export const ADDITIONAL_TRUSTED_WEB_APP_ORIGINS: readonly string[] = [
  "https://app.stage.example",
];
/** REST API origin — used for auth verification and other REST calls (not the Socket.IO relay). */
export const DEFAULT_AUTH_API_ORIGIN =
  readEnvOverride("CL_AUTH_API_ORIGIN") ?? "https://api.closedloop.ai";

export type CapabilityToolName = "claude" | "codex" | "git" | "gh" | "python3";

/**
 * ISS-10591 retired the `tools` member on the operator's ruling. It was
 * hardcoded all-false at both publishers (`/health` and `desktop.hello`) with no
 * reader anywhere, so it could only ever misreport.
 *
 * Cross-repo: a skewed peer may still SEND `tools`. It survives as an unknown
 * key in the capabilities blob and is never re-emitted; readers that still
 * address it get `undefined`, which is the safe default they already handle.
 */
export type ComputeTargetCapabilities = {
  versions: Partial<Record<CapabilityToolName, string>>;
  /**
   * ISS-12784: always `false`. Every earlier build sent `true`, and the server
   * merges new capabilities over the stored ones without clearing this key, so
   * omitting it would leave every upgraded target marked as signing-capable.
   * Readers test `=== true`, so `false` means "unsupported" to old and new
   * servers alike. Drop it once no server or web code reads the key (the
   * web/API half of PLN-2216 T-5.2–T-5.5).
   */
  commandSigning: false;
};

export const EMPTY_CAPABILITIES: ComputeTargetCapabilities = {
  versions: {},
  commandSigning: false,
};

export type HealthResponse = {
  status: "ok";
  machineName: string;
  capabilities: ComputeTargetCapabilities;
  version: string;
  port: number;
  /** Stable Desktop gateway identity used to match this local app to cloud compute targets. */
  gatewayId?: string;
  /** True once this desktop profile has completed setup and can accept cloud commands. */
  onboardingCompleted?: boolean;
};

export type RiskTier = "none" | "low" | "medium" | "high";

/**
 * PRD-532 §7 — the sync-observability tier the user picks in the unified
 * onboarding SyncConsent step: how much locally-computed analytics syncs to the
 * cloud. Full = full session detail; metadata = counts/aggregates only; local =
 * nothing leaves the machine. Stored as `null` until the user consents (nothing
 * syncs by default).
 */
export const SyncObservabilityTier = {
  Full: "full",
  Metadata: "metadata",
  Local: "local",
} as const;

export type SyncObservabilityTier =
  (typeof SyncObservabilityTier)[keyof typeof SyncObservabilityTier];

/**
 * FEA-3907 — the graduated "data sync level" the desktop Settings "Data & Sync"
 * control persists. Ranked least-to-most cloud exposure. This is the single
 * product control that supersedes the scattered connectivity/sync toggles; the
 * settings store derives those booleans from it (see `data-sync-level.ts`, which
 * owns the mapping and the backward-compat migration). Defined here — next to
 * {@link SyncObservabilityTier} — so both this contract type and the mapping
 * module can share it without a circular import.
 */
// ISS-6147: `DataSyncLevel` is NOT declared here any more — it lives in
// `@repo/api/src/types/data-sync-level`, which `@repo/app` imports too. Consumers
// import that leaf directly: re-exporting it here would be a barrel (biome
// `noBarrelFile`).
//
// ISS-10554: both imports of that leaf at the top of this file carry an explicit
// `.ts` extension, and must keep it. The desktop e2e specs import this module, so
// Playwright's ESM loader reads it verbatim — and that loader cannot resolve an
// extensionless `@repo/api/src/types/…` specifier. A TYPE-only import is erased at
// transpile and never reached it; the VALUE import this file now needs is not, and
// an extensionless one aborts the whole `desktop-e2e` suite at load. `.ts` is the
// form every spec and `src/main/packs/convert-engine.ts` already use;
// `apps/desktop/tsconfig.json` enables `allowImportingTsExtensions` for it, and
// Vite resolves it away when it bundles main and the renderer.

/**
 * PRD-532 §7 consent gate — does the chosen tier permit the SESSION-METADATA
 * sync lane (counts/aggregates: session/harness/model counts, token & cost
 * totals, PRs shipped) to leave the machine? `full` and `metadata` both include
 * these aggregates; `local` keeps everything on the machine; `null` means the
 * user has not consented yet, so nothing syncs by default.
 *
 * This predicate does not decide the not-yet-consented (`null`) fallback — the
 * CALL SITE does: an explicit non-`null` tier is an authoritative user choice
 * and is always honored, while a `null` tier suppresses the lane until the user
 * chooses a tier through the unified onboarding flow. Legacy syncing installs
 * are backfilled to a concrete tier by the settings migration so they do not go
 * dark. See the desktop sync services.
 */
export function syncTierAllowsSessionMetadata(
  tier: SyncObservabilityTier | null
): boolean {
  return tier === "full" || tier === "metadata";
}

/**
 * PRD-532 §7 consent gate — does the chosen tier permit the TRANSCRIPT lane
 * (full session detail: conversation turns, tool calls, per-turn timestamps and
 * replays) to leave the machine? Only `full` includes session contents;
 * `metadata` explicitly keeps prompts/turns/tool-calls/file-contents local, and
 * `local`/`null` sync nothing. See {@link syncTierAllowsSessionMetadata} for the
 * flag-gating caveat.
 */
export function syncTierAllowsTranscripts(
  tier: SyncObservabilityTier | null
): boolean {
  return tier === "full";
}

export type AlwaysAllowRule = {
  id: string;
  operationId: string;
  method: string;
  path: string;
  scopePath?: string;
  createdAt: string;
  expiresAt: string;
};

/**
 * FEA-4050: a durable record of an org-distributed opt-in pack the user
 * explicitly declined/dismissed in the {@link OptInDistributionsBanner}. Before
 * this, a decline was tracked only in the banner's in-memory `handledIds`, so
 * the main-process reconcile re-pushed the same `opt_in` distribution on every
 * app restart and the prompt reappeared. Persisting the decision in the
 * settings store lets the reconcile suppress an already-declined pack across
 * restarts while still letting a genuinely-new offer through.
 *
 * Declined identity: keyed on `distributionId`, which is the assignment-level
 * SSOT the reconcile filters on. An admin re-sharing a pack mints a NEW
 * distribution row (new `distributionId`), so a genuinely-new/updated offer is
 * never permanently suppressed by an older decline. `catalogItemId` and
 * `organizationId` are recorded alongside for audit and to disambiguate the
 * offer's origin; `declinedAt` is an ISO-8601 UTC timestamp.
 */
export type DeclinedDistributionRecord = {
  distributionId: string;
  catalogItemId: string;
  organizationId: string;
  /**
   * FEA-4050: the compute target the decline was recorded against — the same
   * dimension the reconcile fetches assigned distributions for. Scopes the
   * decision so a decline made under one user/profile (compute target) does not
   * suppress the same org distribution for a different user/profile after an
   * account switch. Additive + optional: records persisted before this field
   * existed omit it and match any compute target (the prior installation-global
   * behavior), so no existing decline is lost on upgrade.
   */
  computeTargetId?: string;
  declinedAt: string;
};

export type SavedConfig = {
  id: string;
  name: string;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  // cloudApiKey is NOT stored here -- stored encrypted in ApiKeyStore keyed by profile UUID
  /** Provenance of the encrypted API key stored for this profile. Missing values migrate as USER_CREATED. */
  apiKeySource?: "USER_CREATED" | "DESKTOP_MANAGED";
  /** Desktop-managed gateway identity scoped to this saved profile. */
  gatewayId?: string;
  /** Public half of the profile-scoped Ed25519 PoP keypair. */
  gatewayPublicKeyPem?: string;
  /** Security-upgrade protocol version supported by this profile identity. */
  desktopSecurityUpgradeProtocolVersion?: 1;
  /** Last relay compute target observed for this profile. */
  lastComputeTargetId?: string | null;
  /**
   * ISS-9003: the environment key `lastComputeTargetId` was minted under,
   * stamped by the same hello that recorded the id. Additive and optional: a
   * profile saved before this field existed omits it, which reads as unknown and
   * is refused rather than trusted — see `retained-compute-target-identity.ts`.
   */
  lastComputeTargetEnvironmentKey?: string | null;
  /** One-time Settings prompt dismissal scoped to this profile. */
  desktopSecurityPromptDismissedAt?: string | null;
  /** Pending managed onboarding attempt scoped to this profile, if any. */
  pendingOnboardingAttemptId?: string | null;
  /** Gateway port captured at the time this profile was saved. */
  gatewayPort?: number | null;
  /** Relay compute target ID captured at the time this profile was saved. */
  computeTarget?: string | null;
  /**
   * FEA-4005: per-profile sandbox base directory (the gateway's allowed-directory
   * scope root). Optional and additive — profiles persisted before this field
   * existed omit it and fall back to the global `DesktopSettings.sandboxBaseDirectory`
   * when the profile is applied. Preserve omission when absent; never serialize
   * an absent value as an invalid path.
   */
  sandboxBaseDirectory?: string;
};

/**
 * API key provenance — indicates whether the key was created by the desktop
 * (DESKTOP_MANAGED) or by the user in the web dashboard (USER_CREATED).
 *
 * Defined here as a standalone type alias (pure string literal union, no
 * runtime value) so it can be used in both the shared DesktopSettings type
 * and the ManagedKeyHintState below. This is the canonical SSOT definition;
 * api-key-store.ts re-exports this alias so existing imports from that module
 * continue to work without changes.
 */
export type ApiKeyProvenance = "USER_CREATED" | "DESKTOP_MANAGED";

/**
 * Returned by the desktop:get-managed-key-hint-state IPC channel.
 * Indicates whether the Settings panel should show the revival-limitation hint.
 */
export type ManagedKeyHintState = {
  provenance: ApiKeyProvenance | null;
  shouldShow: boolean;
};

export type DesktopSettings = {
  autoApprovalRules: Record<string, RiskTier>;
  alwaysAllowRules: AlwaysAllowRule[];
  /**
   * FEA-4050: org-distributed opt-in packs the user has declined/dismissed.
   * Persisted so the reconcile does not re-surface a declined pack across app
   * restarts (see {@link DeclinedDistributionRecord}).
   */
  declinedDistributions: DeclinedDistributionRecord[];
  sandboxBaseDirectory: string;
  onboardingCompleted: boolean;
  /** Permanent dismissal of the onboarding reminder popup. Session dismissals are not persisted. */
  onboardingPopupDismissedPermanent: boolean;
  /** First-launch Agent Dashboard welcome has been shown and dismissed (FEA-1333). */
  dashboardWelcomeSeen: boolean;
  /**
   * ISS-12552 (PRD-800 "Rollout"): the last settled answer of the
   * `attribution-evidence-policy` flag, held while no answer is available: the
   * organization it turned the policy on for, or null for off. Hidden: no Labs
   * toggle and no UI reads it. Default off.
   */
  attributionEvidenceParsePolicyOrganizationId: string | null;
  /**
   * ISS-12135: organizations whose invite spotlight is already answered on this
   * profile, set by a seeded profile (`scripts/vibe-profile/sign-in.ts`). The
   * renderer's own answer stays in `localStorage`; this is read beside it, for
   * a launcher whose renderer origin (and so its `localStorage`) is new each
   * launch.
   */
  inviteSpotlightAnsweredOrganizationIds: string[];
  /**
   * ISS-5061 re-gate bookkeeping: whether the one-shot clear of any
   * `agent-collaboration-network` value persisted before that toggle was
   * re-registered has already run. Not a user-facing setting.
   *
   * ISS-5280 (#4482) retired the toggle and its migration deletes the key on
   * every boot. Re-registering the toggle makes a persisted value a LIVE
   * setting again, so that unconditional delete would wipe the user's opt-in on
   * each restart. This marker bounds the clear to exactly once — every install
   * still lands on the new OFF default, and the toggle persists thereafter.
   */
  agentCollaborationNetworkResidueCleared: boolean;
  cloudCommandsPaused: boolean;
  cloudConnectionEnabled: boolean;
  /** Host-owned opt-in for Plans / plan extraction UI in the embedded Agent Dashboard. */
  planExtractionEnabled: boolean;
  /** Shows personalized agentic-development coaching tips in the Sessions view. */
  agentCoachingTips: boolean;
  /**
   * Lets an installed "coaching pack" override the built-in best-practice
   * signals that power coaching tips. Off → built-in signals only.
   */
  agentCoachingPacks: boolean;
  /**
   * Labs opt-in (ISS-4779 closed-by-default) that shows the "Redacted sessions"
   * option in Settings → Data & Sync. Off by default because the redaction lane
   * is not plumbed yet (redacted behaves as metadata-only today); see
   * feature-flags.ts.
   */
  showRedactedSyncLevel: boolean;
  defaultApprovalTier: RiskTier;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  verboseLogging: boolean;
  binaryPaths?: BinaryPaths;
  savedConfigs: SavedConfig[];
  activeConfigId: string | null;
  sessionCompletionNotifications: boolean;
  /**
   * ISS-6170: opt-in OS notification the first time a cloud-assigned required
   * plugin proves uninstallable on this build.
   */
  terminalInstallFailureNotifications: boolean;
  /**
   * Gates the main-process TranscriptSyncService raw-transcript archive lane
   * (FEA-2715). Off by default and restart-scoped pending end-to-end validation.
   */
  transcriptSyncEnabled: boolean;
  /**
   * PRD-532 §7 — the user's chosen sync-observability tier from the unified
   * onboarding SyncConsent step. `null` until they consent (see
   * {@link SyncObservabilityTier}).
   *
   * ISS-10554: the null is written EXPLICITLY on a first launch, and the key's
   * PRESENCE is load-bearing. Absence is what every build — including an older one
   * that cannot know about a newer build's markers — reads as "never chose, infer
   * from behavior", and the first-launch seed also writes the connectivity flags a
   * full-syncing install would carry, which is exactly the evidence that inference
   * uses. A recorded `null` says "answered, and the answer is no consent", so the
   * tier stays the user's to give. It grants nothing: every gate reads the VALUE,
   * and a null tier fails closed.
   */
  syncObservabilityTier: SyncObservabilityTier | null;
  /**
   * ISS-5489 — the organization the sync consent above was recorded FOR, so an
   * org switch re-prompts. `null` on an install that consented before this
   * binding existed (honored as consent rather than re-asked, see
   * {@link hasRecordedSyncConsent}) and on a consent recorded with no org.
   */
  syncConsentOrganizationId: string | null;
  /**
   * ISS-10890 — whether this DEVICE agreed to local session analysis, by
   * pressing Welcome's "Start Analyzing My Sessions" (operator decision,
   * 2026-09-24). Releases the ISS-10950 boot gate; it grants no egress, which
   * stays on the tier above. Not org-scoped and never cleared: it is the consent
   * record itself, like the tier, so nothing closes it. Its one writer is the
   * `desktop:record-session-analysis-agreement` IPC the Welcome Start calls.
   */
  sessionAnalysisAgreed: boolean;
  /**
   * ISO timestamp when the user last dismissed the managed-key revival hint
   * (D5 / AC-010). Null means never dismissed.
   */
  managedKeyHintDismissedAt: string | null;
  /**
   * The API key provenance that was active when the user last dismissed the hint.
   * Used to detect provenance regression (USER_CREATED → DESKTOP_MANAGED →
   * USER_CREATED) so the hint reappears after a key rotation.
   * Null means the hint has never been dismissed.
   */
  managedKeyHintLastSeenProvenance: "DESKTOP_MANAGED" | "USER_CREATED" | null;
  /**
   * ISS-4792 (ISS-4779 closed-by-default policy for the ISS-4714 UI):
   * desktop-only Labs flag gating the "DB ahead / update required" banner
   * (`AgentMonitorDbAheadBanner`, mounted in `App.tsx`). Off by default — with it
   * off the banner is never rendered. Registered here so getFlag/setFlag type
   * casts remain sound.
   */
  "db-ahead-banner": boolean;
  /**
   * ISS-5574 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
   * (PostHog key "sessions-branches-tab-titles") gating per-page browser tab
   * titles on the Sessions and Branches surfaces. Every one of those pages
   * reported the application-wide title, so several open tabs were
   * indistinguishable. Off by default. Declared here so the key carries a
   * default-off `DesktopSettings` field and is never absent from `getAll()` on
   * a fresh profile; the renderer resolves the gate itself from the signed-in
   * account's PostHog assignment — the same key space the web app reads — so
   * one key gates both surfaces.
   */
  "sessions-branches-tab-titles": boolean;
  /**
   * ISS-6207 (ISS-4779 closed-by-default): desktop-only Labs flag gating the
   * renderer surfacing the second degraded terminal of the boot import — it settled
   * with source files outstanding after their automatic re-drive budget was
   * spent (`retriesExhausted`). Off by default.
   *
   * Gates exactly one thing: the first-launch splash's new give-up SENTENCE
   * (`isBootImportGiveUpVisible`). It gates NO predicate and NO projection — the
   * terminal fact stays on the ingest snapshot with the flag off, and the
   * startup-readiness panel, the Sessions summary cards and the Sessions read
   * gate fold it unconditionally. That is deliberate and load-bearing: the
   * main-process half of this ticket is unconditional, so dropping the field
   * behind a closed flag leaves a stopped import reading as still running and
   * hangs those consumers. Rationale in full, and the revision that proved it,
   * live on `DESKTOP_BOOT_IMPORT_DEGRADED_TERMINAL_FEATURE_FLAG_KEY` in
   * `feature-flags-labs-surfaces.ts` — the canonical owner; do not restate it
   * here.
   *
   * Desktop-only surface — `apps/app` has no boot import — so there is
   * no web flag to keep in parity. Registered here so getFlag/setFlag type
   * casts remain sound and `getAll()` reports the closed default on a fresh
   * profile.
   */
  "boot-import-degraded-terminal": boolean;
  /**
   * ISS-5607 (ISS-4779 closed-by-default): desktop-only Labs flag gating the
   * read-source badge in the session DETAIL pane's header. Off by default: with
   * it off the pane renders exactly as it does today and shows no badge.
   * Desktop-only surface — the split is between this machine's SQLite reader and
   * the cloud reader, which `apps/app` has no analogue of. Registered here so
   * getFlag/setFlag type casts remain sound.
   */
  "session-detail-read-source": boolean;
  /**
   * FEA-4204: shared web+desktop UI flag (PostHog key
   * "sessions-comment-count-tag") gating the comment-count tag in the Sessions
   * list's lead cell. Off by default (ISS-4779 closed-by-default); the renderer now reads
   * the signed-in PostHog assignment. Registered here so getFlag/setFlag type casts remain sound and
   * `getAll()` resolves the closed default rather than `undefined` on a fresh
   * profile.
   */
  "sessions-comment-count-tag": boolean;
  /**
   * ISS-6959: shared web+desktop UI flag (PostHog key
   * "branches-pinned-name-column") gating the pinned Name column on the Branches
   * list. Off by default (ISS-4779 closed-by-default); the renderer now reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag type casts remain sound and `getAll()` resolves the
   * closed default rather than `undefined` on a fresh profile.
   */
  "branches-pinned-name-column": boolean;
  /**
   * ISS-5125: shared web+desktop UI flag (PostHog key
   * "member-self-service-install") gating the member self-service install
   * affordance on the packs per-machine block. Off by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound.
   */
  "member-self-service-install": boolean;
  /**
   * ISS-6384: shared web+desktop UI flag (PostHog key
   * "artifact-cell-primitives") gating adoption of the shared artifact cell
   * primitives (`CountCell`, `MonoIdCell`, `InlineScalarCell`) by the four
   * production tables that each hand-rolled the same data types. Off by default
   * (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound.
   */
  "artifact-cell-primitives": boolean;
  /**
   * ISS-6385 (ISS-4779 closed-by-default): the desktop half of the shared
   * web+desktop key gating the create-a-tag-then-pick-its-colour step in
   * `TagPicker`, which this renderer mounts through `BranchesView` ->
   * `BranchesListSurfaceV2` -> `ApprovedBranchesTable`.
   */
  "tag-create-color": boolean;
  /**
   * ISS-8215 / ISS-8214: shared web+desktop UI flag (PostHog key
   * "custom-field-editor-contracts") over the two custom-field editor contract
   * corrections deferred from PR #6074 — persisting the canonical enum-option
   * colour id instead of the add-field dialog's Tailwind class, and excluding
   * the owning row from a reference picker. Off by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound.
   */
  "custom-field-editor-contracts": boolean;
  /** ISS-6400: shared eligible Branch navigation cutover; default off. */
  "eligible-branch-navigation": boolean;
  /**
   * ISS-5523: shared web+desktop UI flag (PostHog key
   * "chart-distinguishable-series") gating distinguishable series colors on the
   * categorical time-series charts. Off, a chart with more series than the
   * palette has slots cycles the palette and draws unrelated series in the same
   * fill; on, it caps at one series per distinguishable color and folds the
   * remainder into a neutral "Other (N)" band. Off by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound.
   */
  "chart-distinguishable-series": boolean;
  /**
   * ISS-4463: shared web+desktop UI flag (PostHog key
   * "insights-spend-outcome") gating the Insights "Spend by outcome" tiles —
   * the TokenOps lens splitting AI spend by the originating session's lifecycle
   * outcome (ended clean / ended with error / still running / not recorded). Off
   * by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound.
   */
  "insights-spend-outcome": boolean;
  /**
   * FEA-4201: shared web+desktop UI flag (PostHog key
   * "sessions-custom-date-window") gating the Sessions listing's explicit
   * from/to date window — the `?from=`/`?to=` URL params, the Custom entry point
   * beside the preset pills, and the clear control beside it.
   * Off, both params are inert and the listing reads over the rolling preset
   * exactly as before. Off by default (ISS-4779 closed-by-default); the renderer now reads
   * the signed-in PostHog assignment. Registered here so getFlag/setFlag type casts remain sound.
   */
  "sessions-custom-date-window": boolean;
  /**
   * ISS-5061: shared web+desktop UI flag (PostHog key
   * "agent-collaboration-network") gating the "Agent Collaboration Network" row
   * on the Insights overview dashboard — the aggregate subagent-collaboration
   * graph (FEA-3537). Off, the row is absent entirely rather than degrading to
   * the graph's own empty state. Off by default (ISS-4779 closed-by-default);
   * the renderer reads the signed-in PostHog assignment. Registered here so getFlag/setFlag type casts remain sound.
   *
   * DELIBERATELY RE-INTRODUCED after ISS-5280 (#4482) retired it — see
   * `@repo/api/src/types/agent-collaboration-network-flag`.
   */
  "agent-collaboration-network": boolean;
  /**
   * ISS-5005: shared web+desktop UI flag (PostHog key
   * "agents-default-sort-usage") gating the Agents catalog's usage-bearing
   * default sort (Invocations descending) and the one-time rewrite of a
   * persisted view still carrying the untouched alphabetical default. Off by
   * default (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound.
   */
  "agents-default-sort-usage": boolean;
  /**
   * ISS-5009: shared web+desktop UI flag (PostHog key
   * "agents-source-provenance-honesty") gating the Agents catalog Source column
   * telling the truth about provenance it does not have — a component with no
   * recorded pack, repository or scope renders the shared em-dash empty glyph
   * instead of repeating its own identifier, a component that HAS provenance
   * renders that provenance with the source type it actually came from, and the
   * Source facet's options, counts and membership all key on the same honest
   * value so an offered option can never match zero rows. Off by default
   * (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound.
   */
  "agents-source-provenance-honesty": boolean;
  /**
   * ISS-5951: shared web+desktop UI flag (PostHog key
   * "branch-timeline-cost-fallback-marker") gating the Branch PR-activity
   * timeline marking its headline cost incomplete whenever that figure is the
   * rendered subtotal rather than the branch's own attributed total — including
   * the arm where the branch has no total at all, which previously rendered a
   * fallback figure with nothing saying it was one. Off by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound and `getAll()` resolves the closed default rather
   * than `undefined` on a fresh profile.
   */
  "branch-timeline-cost-fallback-marker": boolean;
  /** ISS-7090 — finite-window retained Last-active cohort explanation. */
  "branches-cohort-transparency": boolean;
  /**
   * ISS-8510 — Branches approved summary honest first-load shell. Registered
   * here so Desktop settings and Labs metadata keep the shared key typed and
   * default-off while the renderer reads signed-in PostHog assignment.
   */
  "branches-summary-honest-loading": boolean;
  /**
   * ISS-7229 — session-detail "Claude reported" cost row, beside the ClosedLoop
   * estimate. Off by default (ISS-4779 closed-by-default); the renderer reads the
   * signed-in PostHog assignment. Registered here so getFlag/setFlag type casts remain sound and `getAll()`
   * resolves the closed default rather than `undefined` on a fresh profile.
   */
  "session-claude-reported-cost": boolean;
  /**
   * ISS-7259 — session-detail harness launch-attribution rows. Off by default
   * (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound and `getAll()` resolves the closed
   * default rather than `undefined` on a fresh profile.
   */
  "session-launch-attribution": boolean;
  /**
   * ISS-5637: the session-detail Tokens row distinguishing a session that
   * recorded NO token usage from one measured at zero. Off by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound and `getAll()` resolves the closed default rather
   * than `undefined` on a fresh profile.
   */
  "session-tokens-recorded-honesty": boolean;
  /**
   * ISS-7737: the session-detail Turns, Tokens, and Cost rows each naming the
   * population they count, so a parent-only turn count and a subagent-folded
   * token/cost rollup stop reading as a numerator over a denominator. Off by
   * default (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound and `getAll()` resolves the closed
   * default rather than `undefined` on a fresh profile.
   */
  "session-metric-population-disclosure": boolean;
  /**
   * ISS-7427: the Session Trace header's evidence disclosure, naming where the
   * count came from when the session's main transcript is permanently absent.
   * Off by default (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here
   * so getFlag/setFlag type casts remain sound and `getAll()` resolves the
   * closed default rather than `undefined` on a fresh profile.
   */
  "session-trace-evidence-disclosure": boolean;
  /**
   * ISS-8652: the Session Trace's idle rows, giving a pause between two turns
   * its own row and its duration. Off by default (ISS-4779 closed-by-default);
   * the renderer reads the signed-in PostHog assignment. Registered here so getFlag/setFlag type casts remain sound
   * and `getAll()` resolves the closed default rather than `undefined` on a
   * fresh profile.
   */
  "session-trace-idle-rows": boolean;
  /**
   * ISS-7427 AC5: the Session Timeline's coverage disclosure, saying the bars
   * cover only the intervals with synced activity when the session's main
   * transcript is permanently absent. Off by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound and `getAll()` resolves the closed default rather
   * than `undefined` on a fresh profile.
   */
  "session-timeline-coverage-disclosure": boolean;
  /**
   * ISS-7516: shared web+desktop UI flag (PostHog key
   * "session-transcript-never-expected") gating the session-detail transcript
   * panel's NEVER-EXPECTED absence state. A machine whose data-sync level keeps
   * transcripts local never queues one, so its sessions were told indefinitely
   * that the source machine would upload a transcript it is never going to
   * send. Off by default (ISS-4779 closed-by-default). Registered here so
   * getFlag/setFlag type casts remain sound and `getAll()` resolves the closed
   * default rather than `undefined` on a fresh profile.
   */
  "session-transcript-never-expected": boolean;
  /**
   * ISS-5500: shared web+desktop UI flag (PostHog key
   * "agents-definition-empty-state-honesty") gating the Agents component detail
   * Definition panel naming WHY it has no body. Today one line — "We haven't
   * captured this component's definition yet." — serves an identity that was
   * only ever seen by name (nothing was EVER recorded) and one the org
   * demonstrably holds whose body did not load, so the two are indistinguishable
   * on screen. With this on, the empty state is derived from the component's
   * resolution state and says which. Off by default (ISS-4779
   * closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so getFlag/setFlag
   * type casts remain sound.
   */
  "agents-definition-empty-state-honesty": boolean;
  /**
   * ISS-5518/5519: shared web+desktop UI flag (PostHog key
   * "agents-detail-honesty") gating the Agents component detail page stating
   * only what its payload backs up: a content-hash route names the component
   * instead of printing its 64-hex digest,
   * and the "Lines shipped" / "Total cost" cards — which reduce over branch rows
   * the server emits with null measurements, so they are permanently dashed —
   * are dropped instead of sitting beside `LOC / $` as its apparent missing
   * operands. Off by default (ISS-4779 closed-by-default); the renderer reads the
   * signed-in PostHog assignment. Registered here so getFlag/setFlag type casts remain sound AND so `getAll()`
   * carries the key on a fresh profile.
   */
  "agents-detail-honesty": boolean;
  /**
   * ISS-4803: shared web+desktop UI flag (PostHog key
   * "agents-type-tab-overflow") gating the Agents catalog type-tab strip
   * disclosing the tabs it cannot fit behind a real overflow menu, instead of
   * clipping them behind an edge fade no keyboard user can reach. Off by
   * default (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound AND so `getAll()` — which spreads
   * `DEFAULT_DESKTOP_SETTINGS` — reports the key on a fresh profile.
   */
  "agents-type-tab-overflow": boolean;
  /**
   * ISS-5532: shared web+desktop UI flag (PostHog key
   * "agents-card-attribute-labels") gating the Agents catalog card naming the
   * attributes it promotes into its header, instead of opening with a bare
   * value — `Tool —` — that nothing on the card identifies. Off by default
   * (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound AND so `getAll()` — which spreads
   * `DEFAULT_DESKTOP_SETTINGS` — reports the key on a fresh profile.
   */
  "agents-card-attribute-labels": boolean;
  /**
   * ISS-5534: shared web+desktop UI flag (PostHog key
   * "agents-invocations-dedupe") gating the Agents list Invocations summary
   * card counting each invocation once. A `plugin` component is never invoked
   * directly — its invocations are the SUM of its skill/command/subagent/mcp
   * children's — so on the "All" type tab, where the plugin and those children
   * are all rows, the card's flat sum double-counts them. Off by default
   * (ISS-4779 closed-by-default); the renderer reads the signed-in PostHog assignment. Registered
   * here so
   * getFlag/setFlag type casts remain sound AND so `getAll()` — which spreads
   * `DEFAULT_DESKTOP_SETTINGS` — reports the key on a fresh profile.
   */
  "agents-invocations-dedupe": boolean;
  /**
   * ISS-6822: shared web+desktop UI flag (PostHog key
   * "agents-bounded-page-data") gating the Agents list's bounded page-data
   * read — one call returning the visible page, the facet counts, and both
   * summary windows, instead of loading the whole inventory into the renderer
   * to derive them there. Off by default (ISS-4779 closed-by-default); the renderer now reads the signed-in PostHog assignment.
   * Registered here so getFlag/setFlag type casts remain sound AND so
   * `getAll()` — which spreads `DEFAULT_DESKTOP_SETTINGS` — reports the key on a
   * fresh profile.
   */
  "agents-bounded-page-data": boolean;
  /**
   * ISS-6544 — these Labs flags were registered in `FEATURE_FLAGS`
   * WITHOUT a field here, so `getAll()` reported `undefined` for them on a fresh
   * profile instead of the closed `false`. `getFlag` hid it: it reaches the
   * registry default through a `FlagKey` cast, so only the `getAll()` spread of
   * `DEFAULT_DESKTOP_SETTINGS` ever exposed the gap.
   *
   * Each one's rationale, PostHog twin and surface live on its registry entry in
   * `feature-flags.ts` — the single source of truth for what a flag means. These
   * declarations exist so the persisted contract carries the key; they
   * deliberately do not restate it.
   */
  /** ISS-6206 — the honest whole-app cloud-readiness verdict. Desktop-only. */
  stoppedLaneReadiness: boolean;
  /** ISS-5842 — the unified delta-chip treatment on the metric primitives. */
  "metric-delta-unified-pill": boolean;
  /** ISS-6493 — the neutral delta chip taking the same pill as its siblings. */
  "metric-delta-neutral-pill": boolean;
  "sessions-delivery-card-no-data": boolean;
  /** ISS-5266 — the Diagnostics → Withheld tab. Desktop-only. */
  "opencode-withheld-diagnostics": boolean;
  /** ISS-6758 — the Diagnostics → Coverage tab (PRD-488 FR-12). Desktop-only. */
  "activity-coverage-diagnostics": boolean;
  /** ISS-5271 — the Sessions summary cards' honest never-loaded state. */
  "sessions-summary-honest-loading": boolean;
  /** ISS-5566 — the Session Timeline's synthesized-cost disclosure. */
  "session-timeline-synthesized-cost": boolean;
  /** ISS-5850 — the Session Timeline's unmeasured-interval disclosure. */
  "session-timeline-source-extent": boolean;
  /** ISS-8241 — the Branch pull-request box's MEASURED checks projection. */
  "branch-detail-measured-checks": boolean;
  /** ISS-8241 — the Branch pull-request box's base ref and author. */
  "branch-detail-pr-base-and-author": boolean;
  /** ISS-6954/6955/6957/6958 — the Branch detail outcome presentation. */
  "branch-detail-metric-honesty": boolean;
  /** ISS-8427 — session detail's plural Branches row. */
  "session-touched-branches": boolean;
  /**
   * PRD-538 (R5 + R6): desktop-only Labs flag gating the ENTIRE subscription
   * session-limits feature — both the `/usage` capture (ISS-5353) and the nav
   * bars + detail drawer that render it (ISS-5354). Off by default: the feature
   * is not product-approved yet (Marisol, 2026-08-07).
   *
   * The gate is deliberately at the CAPTURE, not the render: with this off the
   * desktop performs no credential read, issues no `/usage` request, schedules
   * no refresh timer, and writes no cached snapshot — a user who has not opted
   * in produces zero outbound traffic from this feature. One key covers both
   * halves so capture can never run while the bars stay hidden.
   *
   * Desktop-only, so there is no PostHog twin to keep in lockstep.
   */
  subscriptionSessionLimits: boolean;
  /**
   * FEA-3843 / PRD-555: desktop-only Labs flag gating the in-app Docs & Help
   * experience (Help view, command-palette docs answers, contextual "Help on
   * this" anchors). Off by default; users opt in through the surviving Labs gate. The
   * `docs-help` IPC itself is always registered — this flag only keeps the
   * renderer surfaces dark until graduation. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  docsHelp: boolean;
  /**
   * ISS-7352 (ISS-4779 closed-by-default): persist the Claude Code OTel cost,
   * API-request, and tool-permission signals the local OTLP receiver already
   * decodes and drops. Off by default, and INTERNAL — unlike its neighbours here
   * there is no opt-in surface: its registry entry is `hiddenFromLabs: true`, and its category is `"Labs"` rather than
   * the `"Data Collection"` that `data-collection-card.tsx` selects on, so
   * neither settings surface renders it and the only way to turn it on is to
   * edit the settings record. Why it ships without that surface (the open
   * consent and partial-coverage questions):
   * `claude-code-otel-capture-flag.ts`. The receiver still binds and ACKs either
   * way — this flag only decides whether what it decodes reaches the local
   * store. Registered here so getFlag/setFlag type casts remain sound.
   */
  claudeCodeOtelCapture: boolean;
  /**
   * ISS-5808 (ISS-4779 closed-by-default): gates the Requests view's live
   * behavior — the while-mounted re-read of events, and the copy that
   * separates a failed read from a genuinely empty list. Off by default; users
   * opt in through the surviving Labs gate. Registered here so getFlag/setFlag type casts
   * remain sound.
   */
  requestsLiveRefresh: boolean;
  /**
   * FEA-3741 (slice 1): per-tool collector enable/disable toggles. Each gates
   * whether the desktop agent-data collector for that harness runs at all
   * (resolved through `getActiveCollectionMode` → `"disabled"` when off, the
   * FEA-1839 SSOT routing seam). Default ON — preserves the always-on posture;
   * turning one off stops that tool's collection (and its tool-home walk that
   * can incidentally touch TCC-protected folders) entirely. Registered in the
   * feature-flag registry so getFlag/setFlag type casts remain sound.
   */
  collectClaudeEnabled: boolean;
  collectCursorEnabled: boolean;
  collectCopilotEnabled: boolean;
  /**
   * ISS-4922: desktop-owned Labs flag gating the Authored PR gate on the Local
   * session lane, so Local and the cloud projection agree on which PRs belong to
   * a session. Off by default (the suppression is user-perceivable). Registered
   * here so getFlag/setFlag type casts remain sound.
   */
  localSessionAuthoredPrGate: boolean;
  /**
   * ISS-7830: desktop-owned Labs flag gating whether this device RECORDS that a
   * user opened a thread — the signal that then overrides the launch-time
   * headless default for an agent-spawned thread. Off by default (the
   * classification it flips is rendered). It gates the CAPTURE, in Electron main
   * where the resolver lives; the classification read runs in the db-host child
   * and could never see it. Registered here so getFlag/setFlag casts stay sound.
   */
  threadViewershipSignal: boolean;
  /**
   * ISS-5037 (ISS-4779 closed-by-default): desktop-owned gate over the ENTIRE
   * Labs navigation section — sidebar section AND every destination displayed
   * under it. Off by default. Its only control is the "Enable Labs" checkbox in
   * the native application menu (the flag is `hiddenFromLabs`), which writes
   * through the ordinary `setFlag` path and broadcasts `desktop:flags-changed`
   * so the sidebar reacts live. Registered here so getFlag/setFlag type casts
   * remain sound.
   */
  labsNav: boolean;
  /**
   * ISS-5310 (ISS-4779 closed-by-default): desktop-owned per-item Labs flag over
   * the Agents destination (sidebar entry + `#/agents`), which moved back into
   * the Labs section. Nested inside `labsNav` — the container gate wins, and
   * this only decides what shows once Labs is on. Off by default; users opt in
   * from the Labs settings card. Registered here so getFlag/setFlag type casts
   * remain sound.
   */
  agentsNav: boolean;
  /**
   * FEA-3907 — the graduated "data sync level", the single SSOT control for how
   * much data goes to the cloud. It supersedes the scattered
   * `cloudConnectionEnabled` / `cloudCommandsPaused` / `transcriptSyncEnabled` /
   * `syncObservabilityTier` combination: the settings store persists this level
   * and derives those flags from it (see `data-sync-level.ts`). `null` is still
   * a legal PERSISTED value — an upgrading install carries it until the boot
   * migration reconciles the legacy flags — so the field stays nullable even
   * though `getAll()` always reports the reconciled level.
   */
  dataSyncLevel: DataSyncLevel | null;
};

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  autoApprovalRules: {},
  alwaysAllowRules: [],
  declinedDistributions: [],
  sandboxBaseDirectory: "",
  onboardingCompleted: false,
  onboardingPopupDismissedPermanent: false,
  dashboardWelcomeSeen: false,
  attributionEvidenceParsePolicyOrganizationId: null,
  inviteSpotlightAnsweredOrganizationIds: [],
  // ISS-5061 re-gate: false on a fresh profile so the one-shot residue clear
  // runs once on the first launch of a build that carries the re-registered
  // toggle, then flips true and never clears again.
  agentCollaborationNetworkResidueCleared: false,
  cloudCommandsPaused: false,
  cloudConnectionEnabled: true,
  planExtractionEnabled: false,
  agentCoachingTips: false,
  agentCoachingPacks: false,
  showRedactedSyncLevel: false,
  defaultApprovalTier: "high",
  relayOrigin: DEFAULT_RELAY_ORIGIN,
  apiOrigin: DEFAULT_AUTH_API_ORIGIN,
  webAppOrigin: DEFAULT_WEB_APP_ORIGIN,
  verboseLogging: false,
  binaryPaths: {},
  savedConfigs: [],
  activeConfigId: null,
  sessionCompletionNotifications: false,
  terminalInstallFailureNotifications: false,
  transcriptSyncEnabled: false,
  syncObservabilityTier: null,
  syncConsentOrganizationId: null,
  sessionAnalysisAgreed: false,
  managedKeyHintDismissedAt: null,
  managedKeyHintLastSeenProvenance: null,
  // ISS-4714 (ISS-4779 closed-by-default): the DB-ahead banner dark-launches
  // OFF; users opt in through the surviving Labs gate.
  "db-ahead-banner": false,
  "sessions-branches-tab-titles": false,
  // ISS-6207 (ISS-4779 closed-by-default): the honest partial-import state
  // dark-launches OFF, so every import surface keeps today's reading; users opt
  // in through the surviving Labs gate.
  "boot-import-degraded-terminal": false,
  // ISS-5607 (ISS-4779 closed-by-default): the session-detail read-source badge
  // dark-launches OFF; users opt in through the surviving Labs gate.
  "session-detail-read-source": false,
  // FEA-4204 (ISS-4779 closed-by-default): the Sessions lead-cell comment-count
  // tag dark-launches OFF; users opt in through the surviving Labs gate.
  "sessions-comment-count-tag": false,
  // ISS-6959 (ISS-4779 closed-by-default): the Branches pinned Name column
  // dark-launches OFF; users opt in through the surviving Labs gate.
  "branches-pinned-name-column": false,
  // ISS-6384 (ISS-4779 closed-by-default): adoption of the shared artifact cell
  // primitives by the four hand-rolling tables dark-launches OFF; users opt in
  // through the surviving Labs gate.
  "artifact-cell-primitives": false,
  "tag-create-color": false,
  // ISS-8215 / ISS-8214 (ISS-4779 closed-by-default): the custom-field editor
  // contract corrections dark-launch OFF; users opt in through the surviving Labs gate.
  "custom-field-editor-contracts": false,
  "eligible-branch-navigation": false,
  // ISS-4463 (ISS-4779 closed-by-default): the Insights "Spend by outcome" lens
  // — both Agents-section tiles over the same `spendByOutcome` data, so the bar
  // and the donut flip together — dark-launches OFF; users opt in via the Labs
  // gate. (The comment here used to describe ISS-5149's track-width density
  // tier: that entry was removed by ISS-5366 and its comment was left stranded
  // above the next key down.)
  "insights-spend-outcome": false,
  // FEA-4201 (ISS-4779 closed-by-default): the Sessions custom from/to window
  // dark-launches OFF; with it off `?from=`/`?to=` are inert and the listing
  // reads over the rolling preset, with no Custom entry point offered.
  "sessions-custom-date-window": false,
  // ISS-5061 (ISS-4779 closed-by-default): the Agent Collaboration Network row
  // on the Insights overview dashboard dark-launches OFF; users opt in via the
  // surviving Labs gate. Deliberately re-introduced after ISS-5280 (#4482) retired it —
  // with it off the row is absent entirely, no card and no grid slot.
  "agent-collaboration-network": false,
  // ISS-5523 (ISS-4779 closed-by-default): distinguishable series colors on the
  // per-model time-series charts dark-launch OFF; with it off those charts keep
  // cycling the categorical palette exactly as they do today.
  "chart-distinguishable-series": false,
  // ISS-5125 (ISS-4779 closed-by-default): the member self-service install
  // affordance on the packs per-machine block dark-launches OFF; with it off
  // the block stays the read-only per-(machine × harness) status list.
  "member-self-service-install": false,
  // ISS-5005 (ISS-4779 closed-by-default): the Agents usage-first default sort
  // dark-launches OFF; with it off the catalog keeps Component ascending and no
  // stored view is rewritten.
  "agents-default-sort-usage": false,
  // ISS-5009 (ISS-4779 closed-by-default): the honest Agents Source column
  // dark-launches OFF; with it off the column keeps echoing the component's own
  // identifier exactly as today.
  "agents-source-provenance-honesty": false,
  // ISS-5951 (ISS-4779 closed-by-default): the Branch timeline's fallback-cost
  // marker dark-launches OFF; with it off the headline keeps marking only the
  // timing-incomplete fallback, exactly as today.
  "branch-timeline-cost-fallback-marker": false,
  "branches-cohort-transparency": false,
  "branches-summary-honest-loading": false,
  // ISS-7229 (ISS-4779 closed-by-default): the Claude-reported cost row
  // dark-launches OFF; with it off session detail shows the estimate alone,
  // exactly as today.
  "session-claude-reported-cost": false,
  // ISS-7259 (ISS-4779 closed-by-default): the launch-attribution rows
  // dark-launch OFF; with it off session detail shows no attribution rows,
  // exactly as today.
  "session-launch-attribution": false,
  // ISS-5637 (ISS-4779 closed-by-default): the Tokens row's reachable unknown
  // state dark-launches OFF; with it off a zero-usage session keeps printing
  // four zeros, exactly as today.
  "session-tokens-recorded-honesty": false,
  // ISS-7737 (ISS-4779 closed-by-default): the population disclosure
  // dark-launches OFF; with it off Turns, Tokens, and Cost each render bare,
  // exactly as today.
  "session-metric-population-disclosure": false,
  // ISS-7427 (ISS-4779 closed-by-default): the Session Trace evidence
  // disclosure dark-launches OFF; with it off the header prints the count
  // alone, exactly as today.
  "session-trace-evidence-disclosure": false,
  // ISS-8652 (ISS-4779 closed-by-default): the trace's idle rows dark-launch
  // OFF; with it off `buildTraceGroups` drops the `idle` turn item exactly as
  // today and the trace renders turn-to-turn with no interstitial.
  "session-trace-idle-rows": false,
  // ISS-7427 AC5 (ISS-4779 closed-by-default): the Session Timeline coverage
  // disclosure dark-launches OFF; with it off the strip renders with no caption,
  // exactly as today.
  "session-timeline-coverage-disclosure": false,
  // ISS-7516 (ISS-4779 closed-by-default): the never-expected transcript state
  // dark-launches OFF; with it off a metadata-level machine's session keeps
  // reading "It'll show up here once the source machine uploads it", exactly as
  // today.
  "session-transcript-never-expected": false,
  // ISS-5500 (ISS-4779 closed-by-default): the honest Definition empty state
  // dark-launches OFF; with it off the panel keeps the single legacy line.
  "agents-definition-empty-state-honesty": false,
  // ISS-5518/5519/5521 (ISS-4779 closed-by-default): the honest component-detail
  // metrics dark-launch OFF; with it off the page keeps printing the content
  // hash, the bare capped count, and both permanently-dashed cards.
  "agents-detail-honesty": false,
  // ISS-4803 (ISS-4779 closed-by-default): the Agents type-tab overflow menu
  // dark-launches OFF; with it off the strip renders every segment and only the
  // scroll track clips them, exactly as today.
  "agents-type-tab-overflow": false,
  // ISS-5532 (ISS-4779 closed-by-default): the named card attributes
  // dark-launch OFF; with it off the card header stacks the bare Type chip and
  // the hand-built metric label exactly as today.
  "agents-card-attribute-labels": false,
  // ISS-5534 (ISS-4779 closed-by-default): the Invocations de-duplication
  // dark-launches OFF; with it off the card sums invocations across every row
  // exactly as today.
  "agents-invocations-dedupe": false,
  // ISS-6822 (ISS-4779 closed-by-default): the bounded page-data read
  // dark-launches OFF; with it off the list loads the whole inventory and
  // reduces it in the renderer exactly as today.
  "agents-bounded-page-data": false,
  // ISS-6544: the flags below were registered as Labs toggles with no default
  // here, so `getAll()` reported `undefined` — unspecified, not closed. Each
  // matches its registry `default`, which is OFF for all of them (ISS-4779
  // closed-by-default). See the matching block in the `DesktopSettings` type.
  stoppedLaneReadiness: false,
  "metric-delta-unified-pill": false,
  // ISS-6493 (ISS-4779 closed-by-default): the neutral delta pill dark-launches
  // OFF; with it off a neutral tone renders bare exactly as today.
  "metric-delta-neutral-pill": false,
  "sessions-delivery-card-no-data": false,
  "opencode-withheld-diagnostics": false,
  "activity-coverage-diagnostics": false,
  "sessions-summary-honest-loading": false,
  "session-timeline-synthesized-cost": false,
  "session-timeline-source-extent": false,
  // ISS-8241 Half A: the measured-checks projection dark-launches OFF; with it
  // off the box asks GitHub live exactly as it does today.
  "branch-detail-measured-checks": false,
  // ISS-8241 Half B: the Branch pull-request box's base ref and author
  // dark-launches OFF; with it off the box reads exactly as today.
  "branch-detail-pr-base-and-author": false,
  // ISS-6954/6955/6957/6958: the Branch detail outcome presentation
  // dark-launches OFF; with it off the screen reads exactly as today.
  "branch-detail-metric-honesty": false,
  // ISS-8427: the plural Branches row dark-launches OFF; with it off the
  // Properties pane renders the single-branch row exactly as today.
  "session-touched-branches": false,
  // PRD-538 (ISS-5353/ISS-5354): subscription session limits dark-launch OFF —
  // not product-approved. Off means no credential read and no /usage call.
  subscriptionSessionLimits: false,
  docsHelp: false,
  // ISS-7352: Claude Code OTel capture dark-launches OFF; with it off the
  // receiver decodes and ACKs exactly as today and writes nothing.
  claudeCodeOtelCapture: false,
  // ISS-5808: Requests live-refresh dark-launches OFF; with it off the view
  // keeps its mount-time snapshot and its previous empty-state copy exactly.
  requestsLiveRefresh: false,
  // FEA-3741 (slice 1): collectors ON by default (unchanged always-on posture),
  // individually disableable via the CLI Tools "Data Collection" toggles.
  collectClaudeEnabled: true,
  collectCursorEnabled: true,
  collectCopilotEnabled: true,
  // ISS-4922: the Local Authored-PR gate is OFF by default (dark launch); users
  // opt in through the surviving Labs gate.
  localSessionAuthoredPrGate: false,
  // ISS-7830 (ISS-4779 closed-by-default): thread-viewership capture is OFF by
  // default; users opt in through the surviving Labs gate.
  threadViewershipSignal: false,
  // ISS-5037 (ISS-4779 closed-by-default): the Labs nav section is OFF by
  // default; the only opt-in is the "Enable Labs" application-menu checkbox.
  labsNav: false,
  // ISS-5310 (ISS-4779 closed-by-default): the Agents destination is OFF by
  // default and nested inside `labsNav`; users opt in through the surviving Labs gate once
  // Labs itself is enabled from the application menu.
  agentsNav: false,
  // ISS-10554: a new install defaults to FULL sync. Egress is unchanged by this
  // default — the first-launch seed records an explicit not-consented
  // `syncObservabilityTier` (`null`) alongside the level, and the egress gate reads
  // that tier, not this level, so it fails closed until the user answers the
  // onboarding consent step.
  dataSyncLevel: RECOMMENDED_DATA_SYNC_LEVEL,
};

/**
 * First-party desktop auth (FEA-2219) wire contract. The main-process
 * {@link DesktopSessionManager} owns the state machine; the renderer mirrors it
 * across the IPC boundary. Per AGENTS.md, status/state and failure-reason values
 * that cross the process boundary live in this one shared module so main and the
 * renderer can't drift — both `desktop-session-manager.ts` and the renderer
 * `desktop-api.d.ts` import these instead of re-declaring them.
 */
export const DesktopAuthStatus = {
  /** Initial state before {@link DesktopSessionManager.restore}. */
  Loading: "loading",
  /** No durable session — the user must sign in. */
  SignedOut: "signed_out",
  /**
   * Sign-in started: generating PKCE + state, starting the loopback listener,
   * and launching the system browser to the web authorize URL.
   */
  OpeningBrowser: "opening_browser",
  /** Browser launched; awaiting the loopback redirect carrying the auth code. */
  AwaitingRedirect: "awaiting_redirect",
  /**
   * Redirect received; redeeming the code (+ PKCE verifier + PoP) for tokens.
   * A sign-in that asked to confirm its account also waits here, with
   * {@link DesktopAuthState.pendingAccount} set, until the user answers
   * (ISS-11345). Nothing is adopted until then.
   */
  Exchanging: "exchanging",
  /** A durable session exists; access tokens are minted on demand. */
  Authenticated: "authenticated",
  /**
   * The install holds a session it cannot currently use, and the user must act.
   * The in-memory credential is always dropped, so this status means the same
   * thing to every reader. What differs is the PERSISTED record: a credential
   * the server invalidated/expired/revoked is wiped, while (ISS-11273) a
   * startup restore that threw before it could decide — an unreadable keystore,
   * an `apiOrigin` that fails validation — leaves it on disk, because the cause
   * says nothing about the credential and the next launch re-reads it.
   */
  RefreshFailed: "refresh_failed",
} as const;
export type DesktopAuthStatus =
  (typeof DesktopAuthStatus)[keyof typeof DesktopAuthStatus];

/** Renderer-facing snapshot of the main-process desktop auth state. */
export type DesktopAuthState = {
  status: DesktopAuthStatus;
  /** Internal user id, for display/bootstrapping only — never authorization. */
  userId: string | null;
  organizationId: string | null;
  /** True while main holds a short-lived, one-operation bootstrap credential. */
  awaitingOrganization?: boolean;
  /**
   * Clerk subject for the signed-up user while no internal org-bound user row
   * exists yet. Additive and separate from `userId`, whose value is always an
   * internal database id and must not be overloaded with a provider id.
   */
  pendingUserId?: string;
  /**
   * ISS-10913: the evaluated outcome of the last auth return, for the FTUE
   * funnel's `account_mode`. ADDITIVE and optional: a gateway that predates it
   * omits the field, and `onboardingAccountModesForOutcome` folds that absence
   * to `["unknown"]` rather than guessing from the status such a payload does
   * still carry.
   */
  accountOutcome?: OnboardingAccountOutcome;
  /**
   * ISS-11345: the account a confirmation-gated sign-in redeemed and is holding
   * UNADOPTED — present only while status is `Exchanging` and the user has not
   * yet confirmed. The browser picks the account, so a shared browser can hand
   * Desktop someone else's; this is what the user is shown before it is used.
   */
  pendingAccount?: DesktopIdentity;
  /**
   * ISS-12257: main's count of sign-in flips, each time `status` enters or
   * leaves `Authenticated`. A replay recording reports the count it started
   * under, and main refuses its batches once the count has moved on.
   */
  authGeneration?: number;
};

export type DesktopBootstrapOrganizationInput =
  DesktopBootstrapOrganizationRequest;

export type DesktopBootstrapOrganizationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * ISS-11345: per-call options for a browser sign-in. `confirmAccount` holds the
 * redeemed session unadopted until the user confirms the account the browser
 * returned (see {@link DesktopAuthState.pendingAccount}).
 */
export type DesktopSignInOptions = {
  confirmAccount?: boolean;
};

/** Closed set of terminal browser sign-in failure reasons. */
export type DesktopBrowserSignInFailure =
  /** Browser sign-in ports were not configured on this manager. */
  | "unavailable"
  /** A sign-in is already running, or a session already exists. */
  | "already_in_progress"
  /** Pre-open setup failed (device descriptor / PKCE / loopback listener). */
  | "start_failed"
  /** The system browser could not be opened. */
  | "open_failed"
  /** No loopback callback arrived before the timeout (e.g. user abandoned it). */
  | "redirect_timeout"
  /** The callback `state` did not match, or it carried no `code` (mix-up/CSRF). */
  | "state_mismatch"
  /** The authorization code was invalid/expired/replayed at redeem. */
  | "expired"
  /** Sign-in was cancelled (explicit cancel or sign-out). */
  | "cancelled"
  /**
   * ISS-11345: the user answered Cancel to the account a confirmation-gated
   * sign-in held. Main settles that run as `cancelled`; the renderer's
   * `DesktopAuthProvider`, which renders the confirmation, reports it as this.
   */
  | "declined"
  /** The code redeem (token exchange) failed on the network / PoP / server. */
  | "exchange_failed";

/** Terminal outcome of a browser sign-in request. */
export type DesktopBrowserSignInResult =
  | { ok: true }
  | { ok: false; reason: DesktopBrowserSignInFailure };

/**
 * Existing-user resolution state (PRD-532 §8 / M6). A user who already has an
 * `sk_live_*` API key but no first-party Clerk/GitHub desktop session is an
 * "existing user" the platform tries to bring onto unified auth without
 * disrupting their working local + API-key access.
 *
 * `kind`:
 * - `none` — nothing to offer: either no API key, a live session already
 *   exists, or resolution is still loading. No prompt.
 * - `prompt` — an API key is present with no desktop session. Surface the
 *   one-time, dismissible "Sign in with GitHub to sync" prompt. Never blocks;
 *   local + API-key access keep working until the user acts.
 *
 * Resolution is an OFFER, never an action: the desktop never trades the API key
 * for a session on its own. A non-interactive API-key→session mint used to run
 * silently on every signed-out transition, which re-authenticated users who had
 * just signed out; it was removed, and signing in is now always something the
 * user initiates.
 *
 * This is a NON-SECRET UI signal only. It never carries a token, refresh token,
 * PoP material, or the API key itself — only whether to show the prompt and
 * whether the user has already dismissed it.
 */
export type DesktopExistingUserResolution = {
  kind: "none" | "prompt";
  /** True once the user has dismissed the prompt (persisted; one-time). */
  dismissed: boolean;
};
