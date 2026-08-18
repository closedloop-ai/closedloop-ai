/**
 * Honest copy for a member install DISPATCH outcome (ISS-5125).
 *
 * A dispatch result is not an install result, and the packs surfaces must never
 * blur the two. `POST /compute-targets/{id}/member-installs` reports only what
 * the CLOUD proved about handing the command to the node
 * (`MemberPackInstallDispatchState`); the node reports the terminal on-device
 * install over its own command-event stream afterwards. So every string here is
 * written about the DISPATCH — "install started", "waiting to confirm",
 * "nothing was installed" — and none of them claims the pack is installed. That
 * claim belongs to the cell's `PackInstallState` on the next read, which is the
 * only thing that actually knows.
 *
 * The three-way split the member needs, and which this module preserves:
 *  - the node took it (`Dispatched`) — a settled, good outcome;
 *  - we could not confirm (`Pending`) — genuinely unknown, and explicitly NOT
 *    offered as a retry, because the install may already be running and a second
 *    dispatch would duplicate it;
 *  - it definitely did not happen (`TargetOffline` / `Failed`) — a real failure,
 *    retryable, with the reason named rather than a bare "something went wrong".
 */

import {
  MemberPackInstallDispatchReason,
  MemberPackInstallDispatchState,
} from "@repo/api/src/types/member-pack-install";
import { ApiError } from "../../shared/api/api-error";

/**
 * The tone a dispatch outcome reads in — chosen so the state is legible without
 * relying on color: `Danger` pairs with the destructive token AND a failure
 * word, `Pending` with a muted "unconfirmed" word. A const object so surfaces
 * compare against the member.
 */
export const MemberInstallDispatchTone = {
  /** The node took the command. */
  Success: "success",
  /** Sent, but unconfirmed — may or may not be running. */
  Pending: "pending",
  /** Provably not installed. */
  Danger: "danger",
} as const;
export type MemberInstallDispatchTone =
  (typeof MemberInstallDispatchTone)[keyof typeof MemberInstallDispatchTone];

export type MemberInstallDispatchCopy = {
  /** One sentence the member reads under the cell. */
  readonly message: string;
  readonly tone: MemberInstallDispatchTone;
  /**
   * Whether offering the action again is safe. FALSE for the ambiguous
   * `Pending` outcome: the relay may already have emitted the command, so a
   * "retry" could run the install twice. The API is explicit that ambiguous
   * transport failures are deliberately not terminal for exactly this reason.
   */
  readonly retryable: boolean;
};

/**
 * Reason-specific copy for the two up-front preflight failures. Both are
 * terminal `Failed` outcomes that never created a command, and both have a
 * concrete remedy the generic failure sentence would hide — so they are named
 * rather than collapsed into "couldn't start the install".
 *
 * Every OTHER reason (including an unknown one from a newer API) falls through
 * to the generic message below, which is the version-skew safe default: a
 * reason string this client does not recognise must degrade to an honest
 * generic failure, never to an empty or `undefined` sentence.
 *
 * A `Map`, not an object literal, because `reason` is an UNVALIDATED wire
 * string. An object lookup answers inherited keys — `"constructor"` and
 * `"toString"` return functions, which are truthy and so slip past the `??`
 * fallback and render a blank or nonsense outcome. A `Map` only ever answers
 * keys actually put in it.
 */
const FAILED_REASON_MESSAGE = new Map<string, string>([
  [
    MemberPackInstallDispatchReason.OperationNotSupported,
    "This machine's desktop app is too old to install packs from the web. Update it and try again.",
  ],
  [
    MemberPackInstallDispatchReason.SigningRequired,
    "This machine only accepts signed commands, which a web install can't provide. Install it from the desktop app instead.",
  ],
]);

/**
 * Turn a dispatch state (plus its optional reason) into the sentence and tone
 * the member install control renders.
 *
 * Exhaustive over `MemberPackInstallDispatchState` — a state added to the wire
 * contract fails typecheck here until it is given honest copy, so a new outcome
 * can never render blank. At runtime an unknown state cast past the type
 * degrades to the generic failure, which is the safe claim: it never asserts an
 * install that may not have happened.
 */
export function memberInstallDispatchCopy(
  state: MemberPackInstallDispatchState,
  computeTargetName: string,
  reason?: string
): MemberInstallDispatchCopy {
  switch (state) {
    case MemberPackInstallDispatchState.Dispatched: {
      return {
        message: `Install started on ${computeTargetName}.`,
        tone: MemberInstallDispatchTone.Success,
        retryable: false,
      };
    }
    case MemberPackInstallDispatchState.Pending: {
      return {
        message: `Install sent to ${computeTargetName}. We couldn't confirm it started — this machine will report back when it does.`,
        tone: MemberInstallDispatchTone.Pending,
        retryable: false,
      };
    }
    case MemberPackInstallDispatchState.TargetOffline: {
      return {
        message: `${computeTargetName} is offline, so nothing was installed. Try again once it reconnects.`,
        tone: MemberInstallDispatchTone.Danger,
        retryable: true,
      };
    }
    case MemberPackInstallDispatchState.Failed: {
      return {
        message:
          (reason ? FAILED_REASON_MESSAGE.get(reason) : undefined) ??
          `We couldn't start the install on ${computeTargetName}. Nothing was installed.`,
        tone: MemberInstallDispatchTone.Danger,
        retryable: true,
      };
    }
    default: {
      return assertExhaustiveDispatchCopy(state, computeTargetName);
    }
  }
}

/**
 * Copy for a dispatch whose POST never produced a wire state — the request
 * itself failed.
 *
 * The tempting reading is "the request failed, so nothing was installed, so
 * offer Retry". That is not sound, and the shape of the route is why:
 * `dispatchMemberPackInstall` creates the command AND hands it to the relay
 * INSIDE one `try`, answering `errorResponse(...)` from the `catch`. A 5xx can
 * therefore be raised after the node has already taken the install. A response
 * that never arrives at all — a client deadline, a dropped connection — proves
 * even less: the server may have completed the whole dispatch and only the
 * answer was lost. In both cases a "retry" is a second install of the same pack
 * onto the same node.
 *
 * So the split is drawn on what the SERVER proved, never on what the client
 * guessed:
 *  - **4xx** — the request was rejected on its own terms (auth, validation, a
 *    target this member does not own). Those paths return before any command
 *    exists, so nothing was installed. Not retryable either, but for the
 *    opposite reason: re-sending a byte-identical request that was just refused
 *    cannot succeed, and a Retry button that always fails is a lie of its own.
 *  - **5xx, timeout, or no response** — unconfirmed. Same treatment as the
 *    ambiguous `Pending` wire state: say we could not confirm, and withhold the
 *    retry.
 *
 * Retry remains available where it is provably safe, which is where the server
 * said so: `TargetOffline` and terminal `Failed` are answers, and both mean the
 * command did not reach the node.
 */
export function memberInstallRequestFailureCopy(
  error: unknown,
  computeTargetName: string
): MemberInstallDispatchCopy {
  if (error instanceof ApiError && error.isClientError()) {
    return {
      message: `We couldn't start the install on ${computeTargetName}. Nothing was installed.`,
      tone: MemberInstallDispatchTone.Danger,
      retryable: false,
    };
  }
  return {
    message: `We couldn't confirm the install on ${computeTargetName} — it may still be running. Check the machine before trying again.`,
    tone: MemberInstallDispatchTone.Pending,
    retryable: false,
  };
}

/**
 * Exhaustiveness guard. A new `MemberPackInstallDispatchState` fails typecheck
 * here (`never`) until it is given copy above. At runtime — reachable only when
 * a version-skewed API returns a state this build does not know — it degrades
 * to UNCONFIRMED, not to a failure claim and not to a success claim.
 *
 * Unknown is not the same as failed. A state this build does not recognise came
 * from a NEWER server, and the states a newer server is most likely to add are
 * refinements of an accepted dispatch, not new ways of refusing one. Reporting
 * it as a retryable failure would therefore invite the member to re-dispatch an
 * install the node may already have taken — the same duplicate this module
 * exists to prevent for `Pending`. So it lands where every other unprovable
 * outcome lands: say only that we could not confirm it, and withhold the retry.
 */
function assertExhaustiveDispatchCopy(
  _state: never,
  computeTargetName: string
): MemberInstallDispatchCopy {
  return {
    message: `We couldn't confirm the install on ${computeTargetName}. Check the machine before trying again.`,
    tone: MemberInstallDispatchTone.Pending,
    retryable: false,
  };
}
