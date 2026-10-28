import {
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
  parseGitHubResyncNudgeBody,
} from "@repo/api/src/types/github-dirty-scope";
import {
  type DbHostExitError,
  findDbHostExitError,
} from "../../shared/db-host-exit-error.js";
import type { DesktopCommandEvent } from "../cloud/cloud-protocol.js";
import type { CloudSocketService } from "../cloud/cloud-socket.js";
import {
  type ReservedCommandAckPayload as CommandAckPayload,
  type ReservedCommandEventPayload as CommandEventPayload,
  classifyReservedCommand,
  type ReservedCommandMatch,
  rejectReservedCommand,
} from "../cloud/reserved-command-handler.js";
import {
  type ActiveCommandKeyTargetContext,
  BrowserCommandKeyTargetContextOutcome,
  type BrowserCommandKeyTargetContextRejection,
  classifyBrowserCommandKeyTargetContext,
  parseBrowserCommandKeyCommandTargetContext,
} from "./github-resync-nudge-target-context.js";

export type GitHubResyncNudgeCommandMatch = ReservedCommandMatch;

export const GITHUB_RESYNC_NUDGE_INVALID_REASON =
  "invalid github resync nudge payload";

/**
 * ISS-7486: one wire reason per condition the nudge can refuse a context on.
 *
 * These replace the single `github resync nudge target context mismatch`, which
 * carried 100% of the 39,110 rejected acks measured over the 7 days to
 * 2026-09-14 and could not say which of three conditions produced them. That
 * string is no longer emitted but is still accepted by the cloud fold
 * (`packages/api/src/types/desktop-command-ack.ts`), so an older Desktop build
 * keeps a bucket of its own and traffic landing there reads as rollout lag
 * rather than as an unexplained reject.
 *
 * `satisfies` over the rejection union so a new outcome fails `tsc` here rather
 * than falling through to an unnamed reject in production.
 */
export const GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS = {
  [BrowserCommandKeyTargetContextOutcome.CommandContextAbsent]:
    "github resync nudge target context absent",
  [BrowserCommandKeyTargetContextOutcome.ActiveContextUnresolved]:
    "github resync nudge active target context unresolved",
  [BrowserCommandKeyTargetContextOutcome.ComputeTargetMismatch]:
    "github resync nudge compute target mismatch",
  [BrowserCommandKeyTargetContextOutcome.GatewayMismatch]:
    "github resync nudge gateway mismatch",
} as const satisfies Record<BrowserCommandKeyTargetContextRejection, string>;

export type GitHubResyncNudgeHandlerOptions = {
  getActiveTargetContext?: () => ActiveCommandKeyTargetContext | undefined;
  sendCommandAck: (event: CommandAckPayload) => void;
  sendCommandEvent: (event: CommandEventPayload) => void;
  notifyRendererRefresh: (body: unknown) => void | Promise<void>;
  log?: (level: "warn", message: string) => void;
};

/** Identifies the narrow server-control GitHub resync nudge command. */
export function classifyGitHubResyncNudgeCommand(
  command: Pick<DesktopCommandEvent, "method" | "operationId" | "path">
): GitHubResyncNudgeCommandMatch {
  return classifyReservedCommand(command, {
    method: GITHUB_RESYNC_NUDGE_METHOD,
    operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
    path: GITHUB_RESYNC_NUDGE_PATH,
  });
}

export async function handleGitHubResyncNudgeCommand(
  command: DesktopCommandEvent,
  options: GitHubResyncNudgeHandlerOptions
): Promise<void> {
  const parsed = parseGitHubResyncNudgeBody(command.body);
  const targetContext = parseBrowserCommandKeyCommandTargetContext(parsed.body);
  if (targetContext.kind === "invalid") {
    rejectNudge(command, options, GITHUB_RESYNC_NUDGE_INVALID_REASON);
    return;
  }
  const contextOutcome = classifyBrowserCommandKeyTargetContext({
    commandContext: targetContext,
    activeContext: options.getActiveTargetContext?.(),
  });
  if (contextOutcome !== BrowserCommandKeyTargetContextOutcome.Match) {
    rejectNudge(
      command,
      options,
      GITHUB_RESYNC_NUDGE_CONTEXT_REJECTION_REASONS[contextOutcome]
    );
    return;
  }

  options.sendCommandAck({
    commandId: command.commandId,
    accepted: true,
    state: "accepted",
  });
  try {
    await options.notifyRendererRefresh(parsed.body);
  } catch (error) {
    options.log?.(
      "warn",
      describeGitHubResyncNudgeRefreshFailure(command.commandId, error)
    );
  }
  options.sendCommandEvent({
    commandId: command.commandId,
    sequence: 1,
    eventType: "done",
    data: {
      type: "done",
      fallback: !parsed.ok,
    },
  });
}

function rejectNudge(
  command: DesktopCommandEvent,
  options: GitHubResyncNudgeHandlerOptions,
  reason: string
): void {
  rejectReservedCommand(command, options, "GitHub resync nudge", reason);
}

/**
 * Addressing identity for the read-only resync nudge (ISS-8049): the live
 * connection's own compute-target identity. The sender must name this exact
 * target, and a gateway it names must be the one this connection's hello
 * declared (ISS-12032). Offline → undefined, and the handler keeps rejecting.
 */
export function resolveGitHubResyncNudgeTargetContext(input: {
  onlineComputeTargetId: string | null;
  gatewayId: string | null | undefined;
}): ActiveCommandKeyTargetContext | undefined {
  if (!input.onlineComputeTargetId) {
    return undefined;
  }
  return {
    computeTargetId: input.onlineComputeTargetId,
    ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}),
  };
}

export type GitHubResyncNudgeAppDeps = Omit<
  GitHubResyncNudgeHandlerOptions,
  | "getActiveTargetContext"
  | "notifyRendererRefresh"
  | "sendCommandAck"
  | "sendCommandEvent"
> & {
  getOnlineComputeTargetId: () => string | null;
  /**
   * The socket the nudge arrived on: it carries the acks and events, and its
   * last hello's gatewayId is the one the nudge is compared against, so that
   * id cannot be sourced from anywhere else (ISS-12032).
   */
  cloudSocket: Pick<
    CloudSocketService,
    "getHelloGatewayId" | "sendCommandAck" | "sendCommandEvent"
  >;
  /** The dashboard bridge; undefined when not loaded (fallback payload then). */
  getAgentDashboard: () =>
    | { refreshGitHubBranches: (body: unknown) => Promise<unknown> }
    | null
    | undefined;
  /** Renderer notification on the github-resync channel. */
  sendResyncRefreshToRenderer: (payload: unknown) => void;
};

/**
 * App-facing entry: owns the target-context resolution so the grandfathered
 * app.ts wires flat one-line deps only (ISS-8049).
 */
export async function handleGitHubResyncNudgeFromApp(
  command: DesktopCommandEvent,
  deps: GitHubResyncNudgeAppDeps
): Promise<void> {
  const {
    getOnlineComputeTargetId,
    cloudSocket,
    getAgentDashboard,
    sendResyncRefreshToRenderer,
    ...options
  } = deps;
  await handleGitHubResyncNudgeCommand(command, {
    ...options,
    sendCommandAck: (event) => cloudSocket.sendCommandAck(event),
    sendCommandEvent: (event) => cloudSocket.sendCommandEvent(event),
    notifyRendererRefresh: async (body) => {
      const refresh = await getAgentDashboard()?.refreshGitHubBranches(body);
      sendResyncRefreshToRenderer(refresh ?? { body, branchIds: [] });
    },
    getActiveTargetContext: () =>
      resolveGitHubResyncNudgeTargetContext({
        onlineComputeTargetId: getOnlineComputeTargetId(),
        gatewayId: cloudSocket.getHelloGatewayId(),
      }),
  });
}

/**
 * ISS-8856 — the refresh-failure line, carrying WHY the refresh failed.
 *
 * The containment itself is correct and deliberate: a failed renderer refresh
 * degrades to the cloud's own pull recovery, so it must not propagate out of the
 * nudge. What the line did not do was say what happened. The reason was
 * discarded by a bare `catch {}`, so when the local db-host process died under
 * the refresh the log reported only that a refresh had failed — indistinguishable
 * from a renderer-side failure, and the reason the captured incident's two nudge
 * warnings could not be told apart from the store going away underneath them.
 *
 * The refresh no longer reaches a branch read: ISS-12638 reduced
 * `refreshGitHubResyncBranches` to an acknowledgement that cannot reject, so the
 * only failure that arrives here is the renderer send.
 *
 * The leading clause is deliberately byte-stable. Nothing reads this line today,
 * but it is the string a human greps for in `main.log` when triaging the next
 * occurrence, so the new detail is appended rather than woven in.
 */
export function describeGitHubResyncNudgeRefreshFailure(
  commandId: string,
  error: unknown
): string {
  const surface = error instanceof Error ? error.message : String(error);
  const reason = describeRefreshFailureReason(
    surface,
    findDbHostExitError(error)
  );
  return `GitHub resync nudge ${commandId} refresh failed; relying on pull recovery (${reason})`;
}

/**
 * The parenthesised half: the failure, plus — when it was a db-host exit —
 * whether the LOCAL store is coming back.
 *
 * `DbHostExitError.message` is byte-identical on the recoverable and the
 * unrecoverable branch, so `restartScheduled` is the only sound basis for that
 * distinction (its own module says consumers must read the field rather than
 * assume recovery). Withholding it would leave a line that promises "relying on
 * pull recovery" while staying silent on whether local recovery is even
 * scheduled — which is the ISS-8856 symptom this line is read to diagnose.
 */
function describeRefreshFailureReason(
  surface: string,
  exit: DbHostExitError | null
): string {
  if (exit === null) {
    return surface;
  }
  const cause =
    exit.message === surface ? surface : `${surface}: ${exit.message}`;
  const recovery = exit.restartScheduled
    ? "db-host restart scheduled"
    : "no db-host restart scheduled";
  return `${cause}; ${recovery}`;
}
