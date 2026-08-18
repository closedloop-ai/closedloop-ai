/**
 * Wire contract for member self-service pack installs dispatched from the web
 * app to a member's OWN registered Electron node (FEA-4082).
 *
 * The flow is a cloud→relay→node push: a `WebMember` clicks "Install" in the
 * web app, which POSTs to `apps/api`; the API authorizes that the member owns
 * the target node (see `computeTargetsService.findOwnedById`), builds the pack
 * install gateway operation below, and dispatches it through the existing relay
 * plumbing (`dispatchRelayCommandToRelay`) to the node's local gateway. This is
 * distinct from admin distribution (a pull model where the desktop polls
 * `/desktop/distributions/assigned`); here the member pushes an install to a
 * device they registered.
 *
 * Contract discipline (cross-repo / version-skewed — see AGENTS.md):
 *  - The gateway operation id and path are literal `as const` values shared by
 *    the API dispatcher and the desktop node handler so neither hard-codes a
 *    string. A desktop build that predates the pack-install route simply lacks
 *    the handler and its gateway returns HTTP 501 ("operation not implemented"),
 *    which the API maps to a `failed` dispatch state — the peer never crashes.
 *  - New fields on the request/response must be additive and optional; an
 *    unknown value degrades to a safe default at the boundary.
 *  - `MemberPackInstallDispatchState.TargetOffline` reuses the exact wire string
 *    of the client-owned `PackInstallState.Offline` ("offline", FEA-4083) so the
 *    packs UI renders the honest "Target offline" state without a second
 *    vocabulary. This module deliberately does NOT import that client enum —
 *    `PackInstallState` lives in `@repo/app` and pulls in `@repo/design-system`,
 *    which must not enter the server bundle — but the string is asserted equal
 *    by a shared test so the two cannot drift.
 */

import type { JsonValue } from "./common";

/**
 * Gateway operation id for a member-dispatched pack install. Used as the
 * `operationId` on the relay operation envelope and matched by the desktop node
 * handler.
 */
export const MEMBER_PACK_INSTALL_OPERATION_ID = "member_pack_install" as const;

/**
 * Local gateway route on the member's node that performs the pack install. A
 * desktop build without this route returns 501 (graceful version-skew).
 */
export const MEMBER_PACK_INSTALL_PATH = "/api/gateway/packs/install" as const;

/**
 * The offline wire string, kept identical to `PackInstallState.Offline`
 * ("offline") from `@repo/app/packs/lib/install-state` so the packs UI renders
 * one vocabulary. A shared test pins this equality; do not change one without
 * the other.
 */
export const MEMBER_PACK_INSTALL_OFFLINE_STATE = "offline" as const;

/**
 * Outcome of a member install dispatch, surfaced to the web UI. These describe
 * the DISPATCH lifecycle (did the node take the install?), not the pack's
 * eventual on-device install state — the node reports terminal install progress
 * through the existing command-event stream. The UI collapses these plus the
 * live `PackInstallState` into what it draws.
 *
 *  - `Dispatched` — the node acknowledged receipt; install is in flight there.
 *  - `Pending` — either transport reached a connected node but the node has not
 *    yet acked (queued, not lost), OR the dispatch outcome is AMBIGUOUS (e.g. a
 *    cloud→relay timeout after the relay may already have emitted): the install
 *    may be running on the node, so it is honestly surfaced as unconfirmed-
 *    pending rather than a terminal failure the member could retry into a
 *    duplicate run. The dispatcher keeps the underlying command non-terminal in
 *    both cases so reconnect replay can still reconcile it.
 *  - `TargetOffline` — the node is not currently connected; the install was NOT
 *    taken. A real, surfaced state — never reported as success.
 *  - `Failed` — dispatch PROVABLY failed before reaching the node (wire
 *    conversion, an old node that lacks the pack-install route → 501, a relay
 *    rejection before emit). Terminal and retryable. Ambiguous transport
 *    failures are NOT `Failed` — see `Pending`.
 */
export const MemberPackInstallDispatchState = {
  Dispatched: "dispatched",
  Pending: "pending",
  TargetOffline: MEMBER_PACK_INSTALL_OFFLINE_STATE,
  Failed: "failed",
} as const;
export type MemberPackInstallDispatchState =
  (typeof MemberPackInstallDispatchState)[keyof typeof MemberPackInstallDispatchState];

/**
 * Wire-visible dispatch reason codes surfaced on `MemberPackInstallResponse.reason`.
 * These are contract values (they cross API→web and appear in assertions), so
 * they live here rather than as private constants duplicated into test strings.
 *
 *  - `OperationNotSupported` — an older node lacks the pack-install route (501
 *    version-skew), detected up front; terminal `Failed`, no dispatch.
 *  - `SigningRequired` — the node enforces command signing but the
 *    server-initiated install carries no browser signature; terminal `Failed`,
 *    no dispatch.
 *  - `RelayDispatchFailed` / `TargetNotConnected` — AMBIGUOUS transport
 *    outcomes: the relay may already have emitted the command to the node before
 *    the cloud→relay call timed out / collapsed a peer timeout, so the install
 *    may be running. Surfaced as non-terminal `Pending`, NOT a terminal failure
 *    the member could retry into a duplicate run. `RelayDispatchFailed` is the
 *    cloud→relay fetch timeout/throw; `TargetNotConnected` is the relay's wire
 *    reason, which it also returns when a cross-instance peer proxy times out or
 *    returns a non-JSON body after the peer may have emitted.
 *  - `TargetOffline` — the in-process relay bus proved there is no local
 *    subscriber; a definitive offline state (terminal, surfaced honestly).
 */
export const MemberPackInstallDispatchReason = {
  OperationNotSupported: "operation_not_supported",
  SigningRequired: "command_signing_required",
  RelayDispatchFailed: "relay_dispatch_failed",
  TargetNotConnected: "target_not_connected",
  TargetOffline: "target_offline",
} as const;
export type MemberPackInstallDispatchReason =
  (typeof MemberPackInstallDispatchReason)[keyof typeof MemberPackInstallDispatchReason];

/**
 * Request body for `POST /compute-targets/:id/member-installs`. The `:id` path
 * param carries the member's own target id (authorized server-side); the body
 * names the pack and harness to install on that node.
 */
export type MemberPackInstallRequest = {
  /** Catalog pack id to install. */
  packId: string;
  /** Harness the pack is installed for (e.g. "claude", "codex"). */
  harness: string;
};

/**
 * Response for a member install dispatch.
 *
 * `commandId` correlates the dispatch with the node's subsequent command-event
 * stream so the UI can follow install progress. It is present ONLY when a
 * command row was actually created (any dispatched outcome). Up-front preflight
 * failures (`operation_not_supported`, `command_signing_required`) never create
 * a command, so the field is ABSENT there rather than an empty-string sentinel
 * that would make the correlation key lie. Consumers must treat a missing
 * `commandId` as "no event stream to follow — this is a terminal preflight
 * `Failed`".
 *
 * `reason` is a dispatch diagnostic (a `MemberPackInstallDispatchReason`)
 * present for every non-clean-delivery state, including the ambiguous `Pending`.
 */
export type MemberPackInstallResponse = {
  commandId?: string;
  packId: string;
  harness: string;
  state: MemberPackInstallDispatchState;
  reason?: MemberPackInstallDispatchReason;
};

/**
 * Params carried on the pack-install gateway operation the node receives. Kept
 * additive: an older node reads only the fields it knows.
 */
export type MemberPackInstallOperationParams = {
  packId: string;
  harness: string;
  commandId: string;
} & Record<string, JsonValue>;
