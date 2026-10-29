import type {
  CheckResult as SharedCheckResult,
  CheckResultDebug as SharedCheckResultDebug,
  CheckResultRepair as SharedCheckResultRepair,
  ComputeTarget as SharedComputeTarget,
  ComputeTargetSecurity as SharedComputeTargetSecurity,
  ComputeTargetServerCapabilities as SharedComputeTargetServerCapabilities,
  DesktopSecurityReason as SharedDesktopSecurityReason,
  RemediationLink as SharedRemediationLink,
} from "@closedloop-ai/loops-api/compute-target";
import {
  CLAUDE_CLI_CHECK_ID as sharedClaudeCliCheckId,
  CODEX_CLI_CHECK_ID as sharedCodexCliCheckId,
  DesktopSecurityStatus as sharedDesktopSecurityStatus,
} from "@closedloop-ai/loops-api/compute-target";
import type { JsonObject, JsonValue } from "./common";

// Re-export the primitives that are shared verbatim with @closedloop-ai/loops-api
// so existing `@repo/api`/`packages/api` consumers keep their import paths.
export type ComputeTargetServerCapabilities =
  SharedComputeTargetServerCapabilities;
export const DesktopSecurityStatus = sharedDesktopSecurityStatus;
export type DesktopSecurityStatus =
  (typeof DesktopSecurityStatus)[keyof typeof DesktopSecurityStatus];
export type DesktopSecurityReason = SharedDesktopSecurityReason;
export type ComputeTargetSecurity = SharedComputeTargetSecurity;
export type CheckResultDebug = SharedCheckResultDebug;
export const CLAUDE_CLI_CHECK_ID = sharedClaudeCliCheckId;
export const CODEX_CLI_CHECK_ID = sharedCodexCliCheckId;
export type RemediationLink = SharedRemediationLink;
export type CheckResult = SharedCheckResult;
export type CheckResultRepair = SharedCheckResultRepair;
/**
 * API-side ComputeTarget: the shared loops-api contract plus the api/app-only
 * `selectedHarness` field. `selectedHarness` is intentionally kept out of the
 * published loops-api contract; it is governed entirely within the web/api
 * boundary via `HarnessType` (defined below).
 */
export type ComputeTarget = SharedComputeTarget & {
  selectedHarness: HarnessType;
};

export type NeutralMcpProviderAvailability = {
  available: boolean;
  serverName: string | null;
  matchedUrl: string | null;
  checkedAt: string;
  error?: string | null;
  /**
   * Repairability for the `<provider>-mcp` row the web synthesizes from this
   * entry (ISS-5435). MCP rows are not gateway `checks[]`, so this is the only
   * place the gateway can state whether Repair can act on one. Absent on a
   * gateway that predates ISS-5435, which reads as "not repairable".
   */
  repair?: CheckResultRepair;
};

export type LegacyMcpProviderAvailability = {
  closedloopAvailable: boolean;
  checkedAt: string;
  /** See `NeutralMcpProviderAvailability.repair`. */
  repair?: CheckResultRepair;
};

export type McpProviderAvailability =
  | NeutralMcpProviderAvailability
  | LegacyMcpProviderAvailability;

export type HealthCheckResponse = {
  checks: CheckResult[];
  allRequiredPassed: boolean;
  // claude/codex are individually optional: the health-check validator accepts a
  // partial mcpServers map (a probe may report only one provider), and consumers
  // already guard each provider before use (deriveAvailableHarnesses, UI hooks).
  mcpServers?: {
    claude?: McpProviderAvailability;
    codex?: McpProviderAvailability;
  };
};

export type ComputeTargetHealthCheckSnapshot = {
  id: string;
  organizationId: string;
  computeTargetId: string;
  checkedAt: Date;
  expectedMcpUrl: string | null;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
  result: HealthCheckResponse;
  allRequiredPassed: boolean;
  requiredFailureIds: string[];
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export const COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY =
  "compute-target-signing" as const;

/**
 * The System Check Repair gateway operation (ISS-5389).
 *
 * Current Desktop builds no longer serve it (ISS-12749), but installed older
 * builds still do, and repair mutates the target machine (it clears binary-path
 * overrides and runs `claude plugin enable`). So the API's desktop-command wire
 * catalog and its per-path ownership check at command creation keep reading
 * these until no such build remains.
 */
export const HEALTH_CHECK_REPAIR_OPERATION_ID = "health_check_repair" as const;
export const HEALTH_CHECK_REPAIR_PATH =
  "/api/gateway/health-check/repair" as const;

export const COMMAND_SIGNING_CAPABILITY_KEY = "commandSigning" as const;
export const COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY =
  "commandSigningRequired" as const;
export const BROWSER_KEY_REVOCATION_OPERATION_ID =
  "browser_key_revoke" as const;
export const BROWSER_KEY_REVOCATION_PATH =
  "/api/gateway/internal/browser-key/revoke" as const;
export const BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID =
  "browser_key_approval_request" as const;
export const BROWSER_KEY_APPROVAL_REQUEST_PATH =
  "/api/gateway/internal/browser-key/approval-request" as const;
export const BROWSER_KEY_UNREGISTERED_ERROR_CODE =
  "browser_key_unregistered" as const;
export const BROWSER_KEY_REVOCATION_RESERVED_ERROR_CODE =
  "browser_key_revocation_reserved" as const;

export type CommandSignatureFields = {
  signature: string;
  signaturePayload: string;
  publicKeyFingerprint: string;
};

export type BrowserSignedCommandId = string & {
  readonly __brand: "BrowserSignedCommandId";
};

export type RegisterComputeTargetInput = {
  machineName: string;
  platform: string;
  capabilities?: JsonObject;
  supportedOperations: string[];
  allowedDirectories?: string[];
  pluginVersion?: string;
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: number;
};

export type RegisterComputeTargetResponse = {
  id: string;
  machineName: string;
  isOnline: boolean;
};

export type RelayOperationDispatchRequest = {
  operationId: string;
  operation: string;
  params: JsonValue;
  streaming: boolean;
};

export const DesktopCommandStatus = {
  Queued: "queued",
  Accepted: "accepted",
  Running: "running",
  Done: "done",
  Failed: "failed",
  Cancelled: "cancelled",
  Expired: "expired",
} as const;
export type DesktopCommandStatus =
  (typeof DesktopCommandStatus)[keyof typeof DesktopCommandStatus];

export type DesktopCommandEventType =
  | "status"
  | "chunk"
  | "result"
  | "error"
  | "done";

export type CreateDesktopCommandInput = {
  commandId?: BrowserSignedCommandId;
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: JsonValue;
  timeoutMs?: number;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
  idempotencyKey?: string;
  streaming?: boolean;
  signature?: string;
  signaturePayload?: string;
  publicKeyFingerprint?: string;
};

export type PublicKeyRegistrationRequest = {
  publicKeyBase64: string;
  fingerprint: string;
};

/**
 * Target access values emitted by owner-scoped browser-key discovery. The
 * browser-key trust workflow intentionally does not expose shared-target
 * approval access.
 */
export const BrowserKeyTargetAccess = {
  OwnedTarget: "owned_target",
} as const;
export type BrowserKeyTargetAccess =
  (typeof BrowserKeyTargetAccess)[keyof typeof BrowserKeyTargetAccess];

/**
 * Owner-only compute-target context attached to browser-key discovery results.
 * Desktop uses this to reject broad or shared-target reconciliation payloads.
 */
export type BrowserKeyTargetContext = {
  computeTargetId: string;
  gatewayId?: string;
  access: BrowserKeyTargetAccess;
};

/**
 * Reserved command body for removing a browser command-signing key from the
 * owning Desktop. Target fields are additive context for fail-closed Desktop
 * validation and may be absent when an older API dispatches the command.
 */
export type BrowserKeyRevocationCommandBody = {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
  computeTargetId?: string;
  gatewayId?: string;
};

/**
 * Reserved command body for asking the owning Desktop to trust a browser
 * command-signing key. Target fields scope the prompt to the owner's active
 * compute target without broadening trust to shared targets.
 */
export type BrowserKeyApprovalRequestCommandBody = {
  publicKeyId: string;
  userId: string;
  fingerprint: string;
  computeTargetId?: string;
  gatewayId?: string;
};

export type UserPublicKeySummary = {
  id: string;
  userId: string;
  organizationId: string;
  publicKeyBase64: string;
  fingerprint: string;
  createdAt: string;
};

export type OrganizationPublicKeySummary = UserPublicKeySummary & {
  ownerName: string;
  ownerEmail?: string;
  /**
   * Present only when the listing request was scoped to an owned compute
   * target. Absence can mean an older API response or a compatibility fallback.
   */
  targetContext?: BrowserKeyTargetContext;
};

export type CreateDesktopCommandResponse = {
  commandId: string;
  status: DesktopCommandStatus;
  deduped?: boolean;
};

export type DesktopCommandSummary = {
  commandId: string;
  computeTargetId: string;
  operationId: string;
  status: DesktopCommandStatus;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastSequenceAcked: number;
  idempotencyKey?: string;
};

export type DesktopCommandEvent = {
  commandId: string;
  sequence: number;
  eventType: DesktopCommandEventType;
  data: JsonValue;
  createdAt: string;
};

export const DESKTOP_SECURITY_UPGRADE_OPERATION_ID =
  "desktop_security_upgrade" as const;

export type StartDesktopSecurityUpgradeResponse = {
  commandId: string;
  expiresAt: string;
};

export type DesktopSecurityUpgradeErrorCode =
  | "SESSION_REQUIRED"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_UPGRADEABLE"
  | "UPGRADE_ATTEMPT_CREATE_FAILED"
  | "UPGRADE_COMMAND_DISPATCH_FAILED";

export type DesktopSecurityUpgradeErrorBody = {
  code: DesktopSecurityUpgradeErrorCode;
  retryable: boolean;
};

export const UPDATE_AND_RESTART_OPERATION_ID = "update-and-restart" as const;

export function isTerminalStatus(status: DesktopCommandStatus): boolean {
  return (
    status === DesktopCommandStatus.Done ||
    status === DesktopCommandStatus.Failed ||
    status === DesktopCommandStatus.Cancelled ||
    status === DesktopCommandStatus.Expired
  );
}

export const DesktopHelloNackReason = {
  ComputeTargetRegisterFailed: "compute_target_register_failed",
  ComputeTargetUpdateFailed: "compute_target_update_failed",
  OnlineStateUpdateFailed: "online_state_update_failed",
  PendingCommandsLookupFailed: "pending_commands_lookup_failed",
  InternalError: "internal_error",
} as const;
export type DesktopHelloNackReason =
  (typeof DesktopHelloNackReason)[keyof typeof DesktopHelloNackReason];

export const HarnessType = {
  Claude: "claude",
  Codex: "codex",
} as const;
export type HarnessType = (typeof HarnessType)[keyof typeof HarnessType];

export function isMcpProviderAvailable(
  availability: McpProviderAvailability
): boolean {
  if ("available" in availability) {
    return availability.available;
  }
  return availability.closedloopAvailable;
}

/** The CLI check row whose presence proves a harness can actually be run. */
const HARNESS_CLI_CHECK_IDS: Record<HarnessType, string> = {
  [HarnessType.Claude]: CLAUDE_CLI_CHECK_ID,
  [HarnessType.Codex]: CODEX_CLI_CHECK_ID,
};

/**
 * What the gateway's CLI row says about `harness`, or `undefined` when it sent
 * no such row at all.
 *
 * The three states are deliberately distinct. `false` is EVIDENCE the harness
 * cannot launch; `undefined` is the ABSENCE of evidence, and only the latter
 * may fall back to the MCP signal. Collapsing them into one boolean is what
 * let a snapshot saying `Claude CLI ✗` still derive Claude as available.
 *
 * `checks` is declared non-optional, but this reads a parsed wire payload, so a
 * version-skewed or truncated response can still arrive without it.
 */
function harnessCliOutcome(
  healthCheck: HealthCheckResponse,
  harness: HarnessType
): boolean | undefined {
  const checkId = HARNESS_CLI_CHECK_IDS[harness];
  const row = (healthCheck.checks ?? []).find((check) => check.id === checkId);
  return row === undefined ? undefined : row.passed;
}

/** Whether the gateway reported a connected MCP server for `harness`. */
function hasAvailableHarnessMcp(
  healthCheck: HealthCheckResponse,
  harness: HarnessType
): boolean {
  const availability = healthCheck.mcpServers?.[harness];
  return Boolean(availability && isMcpProviderAvailable(availability));
}

/**
 * Derive which harness types are available from a health check response.
 *
 * A harness is available when its CLI is installed and passing. The matching
 * MCP server is an OPTIONAL enhancement — it is how an already-running agent
 * talks back to the platform, not what makes the harness runnable — and the
 * System Check renders both MCP rows `required: false` for exactly that reason.
 *
 * Before ISS-5687 this read `mcpServers` alone, so a machine reporting
 * `Claude CLI ✓` and `Codex CLI ✓` alongside two unconfigured (optional) MCP
 * entries derived ZERO harnesses and the picker rendered "No AI harness
 * available" — self-contradicting on its face, and the reason a purely optional
 * config gap read as a dead compute target.
 *
 * The MCP signal is a FALLBACK, not an alternative: it is consulted only when
 * the snapshot carries no CLI row for that harness, so a gateway too old to
 * emit the CLI rows under these ids still derives what it did before rather
 * than regressing to an empty list. Once a CLI row exists its verdict is
 * final — a snapshot that says `Claude CLI ✗` alongside a connected Claude MCP
 * server must NOT offer Claude, or auto-selection hands the user a harness the
 * same snapshot already proved cannot launch.
 */
export function deriveAvailableHarnesses(
  healthCheck: HealthCheckResponse
): HarnessType[] {
  return Object.values(HarnessType).filter((harness) => {
    const cliOutcome = harnessCliOutcome(healthCheck, harness);
    return cliOutcome ?? hasAvailableHarnessMcp(healthCheck, harness);
  });
}

/**
 * Whether `target` belongs to the viewer who asked for it.
 *
 * Deliberately NOT `target.userId === <the signed-in user's id>`: those are two
 * different identity domains. `ComputeTarget.userId` is the internal `User.id`
 * UUID (`@db.Uuid`), while a browser only ever holds the Clerk user id
 * (`useAuth().userId`, `user_2…`) — the API resolves one to the other and keeps
 * them as separate `user.id` / `user.clerkId` fields. Comparing them is false
 * for every real user, so such a check silently reports that nobody owns
 * anything rather than failing loudly.
 *
 * The viewer-scoped list response already answers this server-side:
 * `toComputeTarget` populates `ownerName` ONLY for targets the viewer does not
 * own, so its absence IS the ownership signal, and it is the signal the
 * Settings compute-target rows already read.
 *
 * Scoped to viewer-annotated list responses (`GET /compute-targets`);
 * single-target register/update responses carry no viewer context.
 */
export function isComputeTargetOwnedByViewer(
  target: Pick<ComputeTarget, "ownerName">
): boolean {
  return !target.ownerName;
}

const VALID_HARNESS_VALUES = new Set<string>(Object.values(HarnessType));

/**
 * Narrow a stored `selectedHarness` string to a known {@link HarnessType},
 * defaulting to Claude. The column is free-text TEXT, so an older row (or a
 * value a newer build wrote) must degrade to the default rather than reach a
 * dispatch path as an unlaunchable harness.
 *
 * Lives beside {@link HarnessType}, the contract it narrows to, so its
 * `apps/api` consumers (compute-target record mapping and the compute-targets
 * service) share one membership test instead of drifting copies.
 */
export function parseSelectedHarness(
  value: string | null | undefined
): HarnessType {
  return value != null && VALID_HARNESS_VALUES.has(value)
    ? (value as HarnessType)
    : HarnessType.Claude;
}

/**
 * The socket event the cloud answers a `desktop.hello` with, named so the two
 * RELAYED API sites that construct the frame — `internal/relay/socket-event`'s
 * hello handler and its sequence-gap re-ack — cannot drift from the relay that
 * stamps `mintingApiOrigin` onto it in flight. A rename that missed the relay
 * would silently stop the stamp: every ack still delivered, and the adoption
 * guard simply never armed again.
 *
 * The relay is not the only emitter, and the third site answers through this
 * same constant. `apps/api/lib/desktop-gateway-socket-server.ts` emits its own
 * ack twice on the direct-connect socket and never passes through the relay, so
 * it stamps its own statement (ISS-9152): the API's configured
 * `NEXT_PUBLIC_API_URL`, reduced by the same {@link toMintingApiOrigin}. That
 * transport needs one as much as the relayed one does — the desktop has one
 * gateway socket client, it dials `getRelayOrigin()` at the same
 * `/desktop-gateway` namespace both servers mount, and `apiOrigin` remains a
 * separate setting, so a profile pointing `relayOrigin` straight at API
 * deployment A while `apiOrigin` says B reaches that server and reproduces the
 * exact crossed pairing ISS-9081 refuses.
 *
 * The desktop subscriber likewise keeps its own literal. Its listener is pinned
 * by an AST guard (`cloud-socket-presence.test.ts`) that reads the event name
 * out of the source, and an identifier there would narrow that guard to a name
 * match. A subscriber that drifts fails loudly anyway — no ack is ever
 * dispatched — which is the case this constant is not needed for.
 */
export const DESKTOP_HELLO_ACK_SOCKET_EVENT = "desktop.hello.ack" as const;

/**
 * ISS-9081: the API that actually resolved a compute target, stated on
 * `desktop.hello.ack` — by the relay on the relayed transport, and by the API's
 * own socket server on the direct one (ISS-9152) — so the desktop can guard
 * adoption on a fact instead of inferring one from the id.
 *
 * The desktop retains a target id bound to the origin that minted it
 * (ISS-8702), but the ack carried no origin, so `remember` had to stamp the
 * origin the desktop is *currently* pointed at. That is wrong whenever the two
 * disagree: the relay resolves the target against its OWN `CLOSEDLOOP_API_URL`
 * and the desktop's `relayOrigin` is a separate setting from its `apiOrigin`,
 * so a re-register inside environment A hands back a fresh A-minted id that
 * gets stamped as B's.
 *
 * Optional forever, on both sides. A relay on an older build never sends it and
 * the receiver must behave exactly as it did before; a desktop on an older
 * build drops it at the parse. Omitted rather than sent as `null` when the
 * sender cannot name its own API, per the cross-repo omission rule.
 *
 * Carried raw, exactly as the sender spells it: the receiver owns the
 * comparison and normalizes both sides with the same function, so a second
 * normalization here could only disagree with it. Symmetric with the desktop's
 * own `apiOrigin` setting, which is likewise a URL string normalized on compare.
 */
export type DesktopHelloAckMintingOrigin = {
  mintingApiOrigin?: string;
};

/**
 * The bare origin a sender states as `mintingApiOrigin`, or `undefined` when
 * there is nothing parseable to state — in which case the sender OMITS the
 * field. Shared by both emitters (the relay's forwarded acks and the API's
 * direct socket server) so the two transports cannot spell the statement
 * differently. Mirrors the desktop's own `normalizeEnvironmentKey`, which reads
 * it back and lives under `apps/desktop/src/shared`, out of reach from here.
 */
export function toMintingApiOrigin(
  value: string | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
