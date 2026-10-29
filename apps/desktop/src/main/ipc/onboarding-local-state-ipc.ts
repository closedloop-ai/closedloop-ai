/**
 * @file onboarding-local-state-ipc.ts
 * @description ISS-8376 — the producer for
 * {@link ONBOARDING_LOCAL_STATE_CHANNEL}.
 *
 * Reports only facts main already holds and performs no local operation of its
 * own: the sweep it reads from runs at most once per process, off-thread, and
 * is started by the source rather than by a renderer call. Registrar is
 * electron-free (every seam is injected) so it loads under `test:node` and its
 * sender gate can be driven directly.
 */

import { ONBOARDING_LOCAL_STATE_CHANNEL } from "../../shared/onboarding-local-state-contract.js";
import type { OnboardingLocalStateSource } from "../onboarding/onboarding-local-state-source.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

/**
 * Generous bound on the echoed attempt id. A UUID is 36 characters; anything
 * near this is not an identifier, and the value is copied into every response.
 */
const MAX_ATTEMPT_ID_LENGTH = 200;

type IpcMainLike = {
  handle: (
    channel: typeof ONBOARDING_LOCAL_STATE_CHANNEL,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

export type OnboardingLocalStateIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /**
   * ISS-8776: consulted ONLY after the sender predicate has refused, to pick
   * which fact the refusal states. A torn-down window during onboarding is a
   * lifecycle race, and reporting it as an untrusted sender describes an attack
   * that is not happening.
   */
  isRendererWindowGone?: () => boolean;
  source: OnboardingLocalStateSource;
};

/**
 * The renderer's request. `attemptId` is echoed back on the response so a
 * reply belonging to a superseded onboarding attempt can be dropped by the
 * renderer rather than merged into the current one.
 */
function readAttemptId(rawPayload: unknown): string | undefined {
  if (!rawPayload || typeof rawPayload !== "object") {
    return undefined;
  }
  const value = (rawPayload as { attemptId?: unknown }).attemptId;
  if (typeof value !== "string") {
    return undefined;
  }
  // Return what was TESTED, not the raw input: trimming to decide emptiness and
  // then echoing the untrimmed string means the value the renderer compares
  // against is not the one this handler judged. Bounded because the echo is a
  // renderer-supplied string copied verbatim into every response.
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ATTEMPT_ID_LENGTH) {
    return undefined;
  }
  return trimmed;
}

export function registerOnboardingLocalStateIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: OnboardingLocalStateIpcDeps
): void {
  ipcMainLike.handle(ONBOARDING_LOCAL_STATE_CHANNEL, (event, rawPayload) => {
    // The payload names this machine's cloud identity, so it is restricted to
    // the trusted renderer like every other identity-bearing read.
    assertTrustedIpcSender(
      deps.isTrustedSender,
      event,
      deps.isRendererWindowGone
    );
    return deps.source.read(readAttemptId(rawPayload));
  });
}
