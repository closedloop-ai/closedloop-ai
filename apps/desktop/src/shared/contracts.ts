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

export type AlwaysAllowRule = {
  id: string;
  operationId: string;
  method: string;
  path: string;
  scopePath?: string;
  createdAt: string;
  expiresAt: string;
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
  sandboxBaseDirectory: string;
  onboardingCompleted: boolean;
  /** Permanent dismissal of the onboarding reminder popup. Session dismissals are not persisted. */
  onboardingPopupDismissedPermanent: boolean;
  /** First-launch Agent Dashboard welcome has been shown and dismissed (FEA-1333). */
  dashboardWelcomeSeen: boolean;
  cloudCommandsPaused: boolean;
  cloudConnectionEnabled: boolean;
  /** Enables the first-party SQLite-backed Agent Dashboard experience. On by default. */
  agentMonitorEnabled: boolean;
  /** Host-owned opt-in for Plans / plan extraction UI in the embedded Agent Dashboard. */
  planExtractionEnabled: boolean;
  /** Shows personalized agentic-development coaching tips in the Sessions view. */
  agentCoachingTips: boolean;
  /**
   * Lets an installed "coaching pack" override the built-in best-practice
   * signals that power coaching tips. Off → built-in signals only.
   */
  agentCoachingPacks: boolean;
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
  /** Gates the Settings → Account first-party desktop sign-in UI (FEA-2219). */
  desktopFirstPartyAuthEnabled: boolean;
  /**
   * Gates the main-process TranscriptSyncService raw-transcript archive lane
   * (FEA-2715). Off by default and restart-scoped pending end-to-end validation.
   */
  transcriptSyncEnabled: boolean;
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
   * Shared web+desktop UI flag (kebab-case, PostHog convention) that gates the
   * collapsible session-details comments rail (FEA-2479). Default true so the
   * collapse control ships in packaged builds. Not surfaced as a Labs toggle;
   * registered here so getFlag/setFlag type casts remain sound.
   */
  "session-comments-rail-collapse": boolean;
  /**
   * Shared web+desktop UI flag (PostHog key "agents") gating the Agents
   * workspace sidebar entry (FEA-2923). Off by default; users opt in via the
   * Labs panel since the packaged desktop renderer has no PostHog wiring.
   * Registered here so getFlag/setFlag type casts remain sound.
   */
  agents: boolean;
  /**
   * Shared web+desktop UI flag (PostHog key "read-source-indicator") gating the
   * FEA-3120 Local/Cloud/Fallback read-source badge on the Sessions and Branches
   * toolbars. Off by default; users opt in via the Labs panel since the packaged
   * desktop renderer has no PostHog wiring. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  "read-source-indicator": boolean;
  /**
   * Shared web+desktop UI flag (PostHog key "agents-show-tools-mcps-hooks")
   * surfacing Tools, MCPs, and Hooks as first-class kinds in the Agents listing
   * (FEA-3152). Off by default; users opt in via the Labs panel since the
   * packaged desktop renderer has no PostHog wiring. Observable-only — never
   * affects promote/catalog/distribution. Registered here so getFlag/setFlag
   * type casts remain sound.
   */
  "agents-show-tools-mcps-hooks": boolean;
};

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  autoApprovalRules: {},
  alwaysAllowRules: [],
  sandboxBaseDirectory: "",
  onboardingCompleted: false,
  onboardingPopupDismissedPermanent: false,
  dashboardWelcomeSeen: false,
  cloudCommandsPaused: false,
  cloudConnectionEnabled: true,
  agentMonitorEnabled: true,
  planExtractionEnabled: false,
  agentCoachingTips: false,
  agentCoachingPacks: false,
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
  desktopFirstPartyAuthEnabled: false,
  transcriptSyncEnabled: false,
  managedKeyHintDismissedAt: null,
  managedKeyHintLastSeenProvenance: null,
  "session-comments-rail-collapse": true,
  agents: false,
  "read-source-indicator": false,
  "agents-show-tools-mcps-hooks": false,
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
