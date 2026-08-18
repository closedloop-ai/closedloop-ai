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

export const COMMAND_SIGNING_REJECTION_REASONS = {
  noKeysAuthorized: "unauthorized: no keys authorized",
  unsignedCommand: "unauthorized: unsigned command",
  unknownSigningKey: "unauthorized: unknown signing key",
  invalidSignature: "unauthorized: invalid signature",
  staleOrReplayedCommand: "unauthorized: stale or replayed command",
  payloadMismatch: "unauthorized: payload_mismatch",
} as const;

export type CommandSigningRejectionReason =
  (typeof COMMAND_SIGNING_REJECTION_REASONS)[keyof typeof COMMAND_SIGNING_REJECTION_REASONS];

export const BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID = "browser_key_revoke";
export const BROWSER_COMMAND_KEY_REVOKE_PATH =
  "/api/gateway/internal/browser-key/revoke";
export const BROWSER_COMMAND_KEY_REVOKE_METHOD = "POST";
export const BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON =
  "invalid browser command key revocation payload";
export const BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID =
  "browser_key_approval_request";
export const BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH =
  "/api/gateway/internal/browser-key/approval-request";
export const BROWSER_COMMAND_KEY_APPROVAL_REQUEST_METHOD = "POST";
export const BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON =
  "invalid browser command key approval request payload";
export const BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON =
  "browser command key target context mismatch";

/** Browser-key trust is owner-target scoped; shared targets are not valid here. */
export const BROWSER_KEY_TARGET_ACCESS = {
  OwnedTarget: "owned_target",
} as const;
export type BrowserKeyTargetAccess =
  (typeof BROWSER_KEY_TARGET_ACCESS)[keyof typeof BROWSER_KEY_TARGET_ACCESS];

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
 * The stage web app (`app.closedloop-stage.ai`) probes the local gateway's
 * health-check the same way prod does, but the gateway's CORS allowlist only
 * matched the single configured `webAppOrigin` (prod), so the stage probe was
 * CORS-blocked. Additive and forward-compatible: unknown origins still fall
 * through to the existing prod-origins-only / loopback gates.
 */
export const ADDITIONAL_TRUSTED_WEB_APP_ORIGINS: readonly string[] = [
  "https://app.closedloop-stage.ai",
];
/** REST API origin — used for auth verification and other REST calls (not the Socket.IO relay). */
export const DEFAULT_AUTH_API_ORIGIN =
  readEnvOverride("CL_AUTH_API_ORIGIN") ?? "https://api.closedloop.ai";

export type CapabilityToolName = "claude" | "codex" | "git" | "gh" | "python3";

export type ComputeTargetCapabilities = {
  tools: Record<CapabilityToolName, boolean>;
  versions: Partial<Record<CapabilityToolName, string>>;
  /** Desktop can verify browser-origin Ed25519 command signatures. */
  commandSigning?: boolean;
  /** Desktop requires browser-origin Ed25519 command signatures for cloud commands. */
  commandSigningRequired?: boolean;
  /** Desktop supports the loop runner token-refresh protocol. */
  loopRunnerRefreshSupported?: boolean;
  /** Desktop supports the loop runner heartbeat protocol. */
  loopRunnerHeartbeatSupported?: boolean;
};

export const EMPTY_CAPABILITIES: ComputeTargetCapabilities = {
  tools: {
    claude: false,
    codex: false,
    git: false,
    gh: false,
    python3: false,
  },
  versions: {},
  commandSigning: true,
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
export type SyncObservabilityTier = "full" | "metadata" | "local";

/**
 * FEA-3907 — the graduated "data sync level" the desktop Settings "Data & Sync"
 * control persists. Ranked least-to-most cloud exposure. This is the single
 * product control that supersedes the scattered connectivity/sync toggles; the
 * settings store derives those booleans from it (see `data-sync-level.ts`, which
 * owns the mapping and the backward-compat migration). Defined here — next to
 * {@link SyncObservabilityTier} — so both this contract type and the mapping
 * module can share it without a circular import.
 */
export const DataSyncLevel = {
  Off: "off",
  Metadata: "metadata",
  Redacted: "redacted",
  Full: "full",
} as const;
export type DataSyncLevel = (typeof DataSyncLevel)[keyof typeof DataSyncLevel];

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

/**
 * FEA-4169 / ISS-4623 / ISS-4705 — the two NON-boolean states the cached org sync policy
 * can hold. They look alike ("we hold no explicit boolean") but mean opposite
 * things, so {@link orgPolicyAllowsSessionSync} resolves them differently:
 *
 * - `Unknown` — the desktop has NOT resolved a policy value for a server that is
 *   KNOWN to support one. Either nothing has been fetched yet (pre-first-fetch,
 *   offline, signed out, every attempt failed), OR — ISS-4705 — a CURRENT server
 *   that advertised policy support (`sessionSyncPolicySupported === true`)
 *   returned an otherwise well-formed identity that dropped ONLY
 *   `sessionSyncPolicyEnabled` (a buggy-current-server response). This is the
 *   LOADING / cannot-trust state, and it fails CLOSED.
 * - `Unsupported` — the server answered successfully but advertised NO policy
 *   support (omitted the `sessionSyncPolicySupported` capability marker), i.e. an
 *   OLD server that predates the field. This is the VERSION-SKEW state, and it
 *   degrades to the prior device-consent behavior (rationale on
 *   {@link orgPolicyAllowsSessionSync}).
 */
export const OrgSessionSyncPolicyUnresolved = {
  Unknown: "unknown",
  Unsupported: "unsupported",
} as const;
export type OrgSessionSyncPolicyUnresolved =
  (typeof OrgSessionSyncPolicyUnresolved)[keyof typeof OrgSessionSyncPolicyUnresolved];

/**
 * FEA-4169 — the server-owned ORG POLICY value the desktop caches from
 * `GET /desktop/identity` (`sessionSyncPolicyEnabled`). This is the OUTER gate
 * ABOVE per-device sync consent (PRD-542/FEA-4103); the pure predicate
 * {@link orgPolicyAllowsSessionSync} maps a cached value to an allow/deny
 * decision.
 *
 * States:
 * - `true`  — a NEW server explicitly enabled the org (e.g. the Closedloop org).
 * - `false` — a NEW server explicitly disabled the org (the default). Fail-closed:
 *             no session data may egress.
 * - `"unknown"` / `"unsupported"` — see {@link OrgSessionSyncPolicyUnresolved}.
 */
export type OrgSessionSyncPolicyState =
  | boolean
  | OrgSessionSyncPolicyUnresolved;

/**
 * FEA-4169 / ISS-4705 — decide whether the org policy permits ANY local session
 * data to egress, given the cached policy state.
 *
 * This is the OUTER gate: callers still AND it with the existing per-tier device
 * consent (`syncTierAllows*`). It never *widens* consent — it can only suppress.
 *
 * Semantics (privacy gate → fail CLOSED):
 * - policy `true`  → allow (org explicitly enabled; the tier gate decides the rest).
 * - policy `false` → DENY (org explicitly disabled by a NEW server; nothing egresses).
 * - policy `"unknown"` (not resolved for a policy-supporting server: pre-first-fetch,
 *   offline, signed out, every attempt failed, OR — ISS-4705 — a buggy CURRENT
 *   server that advertised support but dropped only the policy field) → DENY.
 *   ISS-4623: this used to allow, which turned the whole load window into an
 *   unknown→allow race where the auth/cloud-online paths could tick a sync lane
 *   before the org policy had ever been read. A privacy gate must not read "still
 *   loading" or a malformed capable-server response as consent, so the load window
 *   now fails closed and opens only once the policy explicitly resolves.
 *   `OrgSyncPolicyStore` self-heals (`ensureResolved` plus its own retry timer), so
 *   unresolved is a latency window rather than a permanent stall.
 * - policy `"unsupported"` (a NEW desktop talking to an OLD server that never sent
 *   the capability marker) → degrade to the prior device-consent behavior (allow
 *   at THIS gate; the tier gate still applies). Rationale (repo cross-repo skew
 *   rule): a server with no policy capability to state must not newly suppress
 *   sync for users who already consented via their device tier — that would be a
 *   regression caused purely by a desktop upgrade. A CURRENT server ALWAYS
 *   advertises support and sends an explicit boolean (default `false` for a
 *   disabled org, `true` for the Closedloop org), so it never lands here: an
 *   explicit `false` still fails closed, and only a genuinely capability-less
 *   response degrades.
 *
 * Egress safety while unsupported: this is the org-policy layer only. The tier
 * gate is ANDed on top, and by default a user who has not consented to a sync
 * tier syncs nothing anyway (tier `null` → no metadata / no transcripts once
 * unified-auth-onboarding is on). So the skew degrade does not itself open an
 * egress path; it defers to the pre-existing device consent. The server also
 * enforces the same policy independently at every ingest boundary
 * (`apps/api/lib/org-session-sync-policy.ts`), so this gate is defense in depth.
 */
export function orgPolicyAllowsSessionSync(
  policy: OrgSessionSyncPolicyState
): boolean {
  if (typeof policy === "boolean") {
    return policy;
  }
  switch (policy) {
    case OrgSessionSyncPolicyUnresolved.Unsupported:
      // Old server that never advertised policy support → version skew, degrade
      // to the prior device-consent behavior (the tier gate still applies).
      return true;
    case OrgSessionSyncPolicyUnresolved.Unknown:
      // Not yet resolved, or a capable-but-buggy current server that dropped the
      // policy field → fail closed until the policy explicitly resolves.
      return false;
    default: {
      // Exhaustiveness guard: a newly added unresolved state must add an arm
      // above rather than inherit an allow/deny nobody reviewed. The `never`
      // assertion is the compile-time half; the runtime half still DENIES,
      // because a privacy gate that lets an unmapped state through fails OPEN.
      const _exhaustive: never = policy;
      return false;
    }
  }
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
  /** Desktop-local opt-in that requires trusted browser command signatures. */
  commandSigningEnforcementEnabled: boolean;
  defaultApprovalTier: RiskTier;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  verboseLogging: boolean;
  binaryPaths?: {
    claude?: string;
    gh?: string;
    codex?: string;
    cursor?: string;
    opencode?: string;
    python3?: string;
    git?: string;
  };
  savedConfigs: SavedConfig[];
  activeConfigId: string | null;
  updateAndRestartEnabled: boolean;
  sessionCompletionNotifications: boolean;
  /** Opt-in OS notification when a loop you launched reaches terminal success. */
  loopCompletedNotificationsEnabled: boolean;
  /**
   * Gates the main-process TranscriptSyncService raw-transcript archive lane
   * (FEA-2715). Off by default and restart-scoped pending end-to-end validation.
   */
  transcriptSyncEnabled: boolean;
  /**
   * PRD-532 §7 — the user's chosen sync-observability tier from the unified
   * onboarding SyncConsent step. `null` until they consent (see
   * {@link SyncObservabilityTier}).
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
   * ISS-4715: desktop-only Labs flag gating the startup-readiness experience.
   * Off by default; the existing first-launch import banner remains the fallback.
   */
  startupReadinessExperience: boolean;
  /**
   * ISS-5574 (ISS-4779 closed-by-default policy): shared web+desktop UI flag
   * (PostHog key "sessions-branches-tab-titles") gating per-page browser tab
   * titles on the Sessions and Branches surfaces. Every one of those pages
   * reported the application-wide title, so several open tabs were
   * indistinguishable. Off by default. Registered here so the same shared key
   * resolves OFF on desktop (Labs opt-in) instead of via the build-type dev
   * default, keeping it from leaking on desktop while hidden on web.
   */
  "sessions-branches-tab-titles": boolean;
  /**
   * ISS-6241 (ISS-4779 closed-by-default): desktop-only Labs flag surfacing the
   * real per-session count on the import splash's live Compute step, so a
   * multi-hour data-revision rebuild stops reading as a hang. Off by default —
   * with it off the step renders the bare activity dot exactly as today.
   * Registered here so getFlag/setFlag type casts remain sound.
   */
  "compute-progress-count": boolean;
  /**
   * ISS-5112 (ISS-4779 closed-by-default): desktop-only Labs flag gating
   * guest-mode first-run onboarding — a signed-out device reaches the Dashboard
   * instead of the blocking auth overlay, and the contextual sign-up entry
   * points that replace it. Off by default: with it off the first-launch
   * onboarding overlay blocks the Dashboard exactly as it does today (PRD-532
   * M4). Desktop-only surface — `apps/app` has no pre-auth desktop first run —
   * so the Labs toggle is the only opt-in and there is no web flag to keep in
   * parity. Registered here so getFlag/setFlag type casts remain sound.
   */
  "guest-onboarding": boolean;
  /**
   * ISS-5607 (ISS-4779 closed-by-default): desktop-only Labs flag gating the
   * read-source badge in the session DETAIL pane's header. Off by default: with
   * it off the pane renders exactly as it does today and shows no badge.
   * Desktop-only surface — the split is between this machine's SQLite reader and
   * the cloud reader, which `apps/app` has no analogue of — so the Labs toggle
   * is the only opt-in. Registered here so getFlag/setFlag type casts remain
   * sound.
   */
  "session-detail-read-source": boolean;
  /**
   * ISS-4890 / ISS-4906 / ISS-4901: shared web+desktop UI flag (PostHog key
   * "sessions-grid-fold-legibility") gating the Sessions grid horizontal-fold
   * legibility pass — relocating a saved column order's Cost column back in
   * front of the fold, damping the resize sawtooth, and fading the scroll
   * region's edges while more columns exist past it. Off by default (ISS-4779
   * closed-by-default); users opt in via the Labs panel since the packaged
   * desktop renderer has no PostHog wiring. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  "sessions-grid-fold-legibility": boolean;
  /**
   * ISS-5125: shared web+desktop UI flag (PostHog key
   * "member-self-service-install") gating the member self-service install
   * affordance on the packs per-machine block. Off by default (ISS-4779
   * closed-by-default); users opt in via the Labs panel since the packaged
   * desktop renderer has no PostHog wiring. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  "member-self-service-install": boolean;
  /**
   * GridTable v2: shared web+desktop UI flag (PostHog key "grid-table-v2")
   * gating the shared `GridTable` enhancement pass — the per-column options
   * menu, hover-revealed sort affordance, row selection and activation,
   * click-to-keyboard cell navigation, the leading utility column, and the
   * rows-per-page control. Off by default (ISS-4779 closed-by-default); users
   * opt in via the Labs panel since the packaged desktop renderer has no
   * PostHog wiring. Registered here so getFlag/setFlag type casts remain sound.
   */
  "grid-table-v2": boolean;
  /**
   * ISS-5523: shared web+desktop UI flag (PostHog key
   * "chart-distinguishable-series") gating distinguishable series colors on the
   * categorical time-series charts. Off, a chart with more series than the
   * palette has slots cycles the palette and draws unrelated series in the same
   * fill; on, it caps at one series per distinguishable color and folds the
   * remainder into a neutral "Other (N)" band. Off by default (ISS-4779
   * closed-by-default); users opt in via the Labs panel since the packaged
   * desktop renderer has no PostHog wiring. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  "chart-distinguishable-series": boolean;
  /**
   * ISS-4463: shared web+desktop UI flag (PostHog key
   * "insights-spend-outcome") gating the Insights "Spend by outcome" tiles —
   * the TokenOps lens splitting AI spend by the originating session's lifecycle
   * outcome (ended clean / ended with error / still running / not recorded). Off
   * by default (ISS-4779
   * closed-by-default); users opt in via the Labs panel since the packaged
   * desktop renderer has no PostHog wiring. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  "insights-spend-outcome": boolean;
  /**
   * ISS-5061: shared web+desktop UI flag (PostHog key
   * "agent-collaboration-network") gating the "Agent Collaboration Network" row
   * on the Insights overview dashboard — the aggregate subagent-collaboration
   * graph (FEA-3537). Off, the row is absent entirely rather than degrading to
   * the graph's own empty state. Off by default (ISS-4779 closed-by-default);
   * users opt in via the Labs panel since the packaged desktop renderer has no
   * PostHog wiring. Registered here so getFlag/setFlag type casts remain sound.
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
   * default (ISS-4779 closed-by-default); users opt in via the Labs panel since
   * the packaged desktop renderer has no PostHog wiring. Registered here so
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
   * (ISS-4779 closed-by-default); users opt in via the Labs panel since the
   * packaged desktop renderer has no PostHog wiring. Registered here so
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
   * closed-by-default); users opt in via the Labs panel since the packaged
   * desktop renderer has no PostHog wiring. Registered here so getFlag/setFlag
   * type casts remain sound and `getAll()` resolves the closed default rather
   * than `undefined` on a fresh profile.
   */
  "branch-timeline-cost-fallback-marker": boolean;
  /**
   * ISS-5500: shared web+desktop UI flag (PostHog key
   * "agents-definition-empty-state-honesty") gating the Agents component detail
   * Definition panel naming WHY it has no body. Today one line — "We haven't
   * captured this component's definition yet." — serves an identity that was
   * only ever seen by name (nothing was EVER recorded) and one the org
   * demonstrably holds whose body did not load, so the two are indistinguishable
   * on screen. With this on, the empty state is derived from the component's
   * resolution state and says which. Off by default (ISS-4779
   * closed-by-default); users opt in via the Labs panel since the packaged
   * desktop renderer has no PostHog wiring. Registered here so getFlag/setFlag
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
   * operands. Off by default (ISS-4779 closed-by-default); users opt in via the
   * Labs panel since the packaged desktop renderer has no PostHog wiring.
   * Registered here so getFlag/setFlag type casts remain sound AND so `getAll()`
   * carries the key on a fresh profile.
   */
  "agents-detail-honesty": boolean;
  /**
   * ISS-4803: shared web+desktop UI flag (PostHog key
   * "agents-type-tab-overflow") gating the Agents catalog type-tab strip
   * disclosing the tabs it cannot fit behind a real overflow menu, instead of
   * clipping them behind an edge fade no keyboard user can reach. Off by
   * default (ISS-4779 closed-by-default); users opt in via the Labs panel since
   * the packaged desktop renderer has no PostHog wiring. Registered here so
   * getFlag/setFlag type casts remain sound AND so `getAll()` — which spreads
   * `DEFAULT_DESKTOP_SETTINGS` — reports the key on a fresh profile.
   */
  "agents-type-tab-overflow": boolean;
  /**
   * ISS-5534: shared web+desktop UI flag (PostHog key
   * "agents-invocations-dedupe") gating the Agents list Invocations summary
   * card counting each invocation once. A `plugin` component is never invoked
   * directly — its invocations are the SUM of its skill/command/subagent/mcp
   * children's — so on the "All" type tab, where the plugin and those children
   * are all rows, the card's flat sum double-counts them. Off by default
   * (ISS-4779 closed-by-default); users opt in via the Labs panel since the
   * packaged desktop renderer has no PostHog wiring. Registered here so
   * getFlag/setFlag type casts remain sound AND so `getAll()` — which spreads
   * `DEFAULT_DESKTOP_SETTINGS` — reports the key on a fresh profile.
   */
  "agents-invocations-dedupe": boolean;
  /**
   * ISS-6544 — the ten Labs flags below were registered in `FEATURE_FLAGS`
   * WITHOUT a field here, so `getAll()` reported `undefined` for them on a fresh
   * profile instead of the closed `false`. `getFlag` hid it: it reaches the
   * registry default through a `FlagKey` cast, so only the `getAll()` spread of
   * `DEFAULT_DESKTOP_SETTINGS` ever exposed the gap.
   *
   * Each one's rationale, PostHog twin and surface live on its registry entry in
   * `feature-flags.ts` — the single source of truth for what a flag means. These
   * declarations exist so the persisted contract carries the key; they
   * deliberately do not restate it.
   *
   * ISS-4556/ISS-4559 — the Sessions displayed-status SSOT. Read in the desktop
   * MAIN process (not the renderer) via `displayed-status-parity-gate.ts`.
   */
  "sessions-displayed-status-parity": boolean;
  /** ISS-6206 — the honest whole-app cloud-readiness verdict. Desktop-only. */
  stoppedLaneReadiness: boolean;
  /** ISS-4773 — the Sessions Cost card's confirmed-billed headline. */
  "sessions-cost-billing-honesty": boolean;
  /** ISS-5842 — the unified delta-chip treatment on the metric primitives. */
  "metric-delta-unified-pill": boolean;
  /** ISS-5266 — the Diagnostics → Withheld tab. Desktop-only. */
  "opencode-withheld-diagnostics": boolean;
  /** ISS-5271 — the Sessions summary cards' honest never-loaded state. */
  "sessions-summary-honest-loading": boolean;
  /** ISS-5548 — full-column click targets on the Session Timeline bars. */
  "session-timeline-column-hit-target": boolean;
  /** ISS-5566 — the Session Timeline's synthesized-cost disclosure. */
  "session-timeline-synthesized-cost": boolean;
  /** ISS-5564 — the Activity breakdown's confidence-basis footer. */
  "session-phase-confidence-disclosure": boolean;
  /** ISS-5841 — the Session Activity phases breakdown. */
  "session-activity-phases": boolean;
  /**
   * PRD-538 (R5 + R6): desktop-only Labs flag gating the ENTIRE subscription
   * session-limits feature — both the `/usage` capture (ISS-5353) and the nav
   * bars + detail drawer that render it (ISS-5354). Off by default: the feature
   * is not product-approved yet (Mike, 2026-08-07).
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
   * this" anchors). Off by default; users opt in via the Labs panel. The
   * `docs-help` IPC itself is always registered — this flag only keeps the
   * renderer surfaces dark until graduation. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  docsHelp: boolean;
  /**
   * ISS-5808 (ISS-4779 closed-by-default): gates the Requests view's live
   * behavior — the while-mounted re-read of events and jobs, and the copy that
   * separates a failed read from a genuinely empty list. Off by default; users
   * opt in via the Labs panel. Registered here so getFlag/setFlag type casts
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
   * PRD-566 / FEA-4348 (formerly FEA-3813 / PRD-553 M1): desktop-side gate for
   * Routines (the renamed "Scheduled Tasks" feature) — the local crewd scheduler
   * host (SchedulerService + SqliteTaskStore daemon) plus the renderer nav/view.
   * Off by default; restart-scoped (the daemon is snapshotted at boot). The key
   * `"routines"` equals the PostHog flag so the same key gates both surfaces.
   * Registered here so getFlag/setFlag type casts remain sound.
   */
  routines: boolean;
  /**
   * Legacy pre-rename "Scheduled Tasks" Labs flag (PRD-553 M1). Optional and NOT
   * in the flag registry. PRD-566 / FEA-4348 renamed the field to `routines` but
   * keeps this key as a compatibility SHADOW so the rename is not a one-way door:
   * `routines` is authoritative on new builds and is mirrored here on boot and on
   * every `setFlag`, so a downgrade to a pre-rename build still reads the current
   * value instead of defaulting the scheduler off (see
   * `migrateScheduledTasksToRoutines` + `SettingsStore.setFlag`). Do not remove
   * until all installs are past the rename (Compatibility Guardrail).
   */
  scheduledTasks?: boolean;
  /**
   * FEA-3847 (PRD-556 M1): desktop-owned Labs flag gating the in-app Audit Bot
   * (`audit:run` — run a crewd review character against the open repo via the
   * harness cascade). Off by default; when off the IPC refuses the run before
   * spawning any harness. Registered here so getFlag/setFlag type casts remain
   * sound. M1 ships no UI (that is M2/FEA-3848).
   */
  auditBot: boolean;
  /**
   * ISS-4922: desktop-owned Labs flag gating the Authored PR gate on the Local
   * session lane, so Local and the cloud projection agree on which PRs belong to
   * a session. Off by default (the suppression is user-perceivable). Registered
   * here so getFlag/setFlag type casts remain sound.
   */
  localSessionAuthoredPrGate: boolean;
  /**
   * FEA-4174 / PRD-545: desktop-owned Labs flag gating Value Numerator 2.0 —
   * the Pensero-powered delivery-metrics numerator normalized onto our
   * session/branch/PR entities (`@repo/pensero`). Off by default; users opt in
   * via the Labs panel. The Pensero client is server-side and env-configured,
   * so an unconfigured install is a no-op regardless of this flag. Registered
   * here so getFlag/setFlag type casts remain sound.
   */
  valueNumeratorV2: boolean;
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
   * and derives those flags from it (see `data-sync-level.ts`). `null` on a
   * fresh field means "not yet migrated / persisted" — the settings store
   * reconciles it from the legacy flags on first read without escalating
   * exposure. Defaults to the recommended `metadata` level for new installs.
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
  commandSigningEnforcementEnabled: false,
  defaultApprovalTier: "high",
  relayOrigin: DEFAULT_RELAY_ORIGIN,
  apiOrigin: DEFAULT_AUTH_API_ORIGIN,
  webAppOrigin: DEFAULT_WEB_APP_ORIGIN,
  verboseLogging: false,
  binaryPaths: {},
  savedConfigs: [],
  activeConfigId: null,
  updateAndRestartEnabled: false,
  sessionCompletionNotifications: false,
  loopCompletedNotificationsEnabled: false,
  transcriptSyncEnabled: false,
  syncObservabilityTier: null,
  syncConsentOrganizationId: null,
  managedKeyHintDismissedAt: null,
  managedKeyHintLastSeenProvenance: null,
  // ISS-4714 (ISS-4779 closed-by-default): the DB-ahead banner dark-launches
  // OFF; users opt in via the Labs panel.
  "db-ahead-banner": false,
  startupReadinessExperience: false,
  "sessions-branches-tab-titles": false,
  // ISS-6241 (ISS-4779 closed-by-default): the import splash's Compute count
  // dark-launches OFF; users opt in via the Labs panel.
  "compute-progress-count": false,
  // ISS-5112 (ISS-4779 closed-by-default): guest-mode first-run onboarding
  // dark-launches OFF, so the signed-out Dashboard keeps its blocking auth
  // overlay; users opt in via the Labs panel.
  "guest-onboarding": false,
  // ISS-5607 (ISS-4779 closed-by-default): the session-detail read-source badge
  // dark-launches OFF; users opt in via the Labs panel.
  "session-detail-read-source": false,
  // ISS-4890/4906/4901 (ISS-4779 closed-by-default): the Sessions grid fold
  // legibility pass dark-launches OFF; users opt in via the Labs panel.
  "sessions-grid-fold-legibility": false,
  // GridTable v2 (ISS-4779 closed-by-default): the shared GridTable
  // enhancement pass dark-launches OFF; users opt in via the Labs panel.
  "grid-table-v2": false,
  // ISS-4463 (ISS-4779 closed-by-default): the Insights "Spend by outcome" lens
  // — both Agents-section tiles over the same `spendByOutcome` data, so the bar
  // and the donut flip together — dark-launches OFF; users opt in via the Labs
  // panel. (The comment here used to describe ISS-5149's track-width density
  // tier: that entry was removed by ISS-5366 and its comment was left stranded
  // above the next key down.)
  "insights-spend-outcome": false,
  // ISS-5061 (ISS-4779 closed-by-default): the Agent Collaboration Network row
  // on the Insights overview dashboard dark-launches OFF; users opt in via the
  // Labs panel. Deliberately re-introduced after ISS-5280 (#4482) retired it —
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
  // ISS-5534 (ISS-4779 closed-by-default): the Invocations de-duplication
  // dark-launches OFF; with it off the card sums invocations across every row
  // exactly as today.
  "agents-invocations-dedupe": false,
  // ISS-6544: the ten flags below were registered as Labs toggles with no
  // default here, so `getAll()` reported `undefined` — unspecified, not closed.
  // Each matches its registry `default`, which is OFF for all ten (ISS-4779
  // closed-by-default). See the matching block in the `DesktopSettings` type.
  "sessions-displayed-status-parity": false,
  stoppedLaneReadiness: false,
  "sessions-cost-billing-honesty": false,
  "metric-delta-unified-pill": false,
  "opencode-withheld-diagnostics": false,
  "sessions-summary-honest-loading": false,
  "session-timeline-column-hit-target": false,
  "session-timeline-synthesized-cost": false,
  "session-phase-confidence-disclosure": false,
  "session-activity-phases": false,
  // PRD-538 (ISS-5353/ISS-5354): subscription session limits dark-launch OFF —
  // not product-approved. Off means no credential read and no /usage call.
  subscriptionSessionLimits: false,
  docsHelp: false,
  // ISS-5808: Requests live-refresh dark-launches OFF; with it off the view
  // keeps its mount-time snapshot and its previous empty-state copy exactly.
  requestsLiveRefresh: false,
  // FEA-3741 (slice 1): collectors ON by default (unchanged always-on posture),
  // individually disableable via the CLI Tools "Data Collection" toggles.
  collectClaudeEnabled: true,
  collectCursorEnabled: true,
  collectCopilotEnabled: true,
  // PRD-566 / FEA-4348: Routines (renamed "Scheduled Tasks") OFF by default (dark
  // launch); users opt in via the Labs panel. Key equals the PostHog flag.
  routines: false,
  // FEA-3847 (PRD-556 M1): in-app Audit Bot OFF by default (dark launch); users
  // opt in via the Labs panel. M1 has no UI, so the flag only enables the IPC.
  auditBot: false,
  // ISS-4922: the Local Authored-PR gate is OFF by default (dark launch); users
  // opt in via the Labs panel.
  localSessionAuthoredPrGate: false,
  // FEA-4174 / PRD-545: Value Numerator 2.0 OFF by default (dark launch); users
  // opt in via the Labs panel.
  valueNumeratorV2: false,
  // ISS-5037 (ISS-4779 closed-by-default): the Labs nav section is OFF by
  // default; the only opt-in is the "Enable Labs" application-menu checkbox.
  labsNav: false,
  // ISS-5310 (ISS-4779 closed-by-default): the Agents destination is OFF by
  // default and nested inside `labsNav`; users opt in via the Labs panel once
  // Labs itself is enabled from the application menu.
  agentsNav: false,
  // FEA-3907: the graduated data sync level. `null` here means "not yet
  // reconciled" for an upgrading install — the settings store migrates it from
  // the legacy flags on first read (see SettingsStore). A brand-new install with
  // no legacy flags reconciles to the recommended `metadata` default.
  dataSyncLevel: null,
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
  /** Redirect received; redeeming the code (+ PKCE verifier + PoP) for tokens. */
  Exchanging: "exchanging",
  /** A durable session exists; access tokens are minted on demand. */
  Authenticated: "authenticated",
  /** Stored credentials became invalid/expired/revoked and were cleared. */
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
