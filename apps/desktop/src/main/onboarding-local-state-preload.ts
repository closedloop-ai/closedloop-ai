import { ONBOARDING_LOCAL_STATE_CHANNEL } from "../shared/onboarding-local-state-contract.js";

type IpcInvokeLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

/**
 * ISS-8376 — the onboarding local-state namespace, assembled here rather than
 * inline so `preload-common.ts` gains one spread instead of a method body (the
 * shape `createSettingsLocalDeviceDesktopApi` established).
 *
 * Resolves `unknown` on purpose. The renderer adapter validates the payload
 * against `parseOnboardingLocalState`; a preload that pre-typed it would hand
 * the renderer a shape nothing had checked.
 *
 * This spread is the link nothing else covers: drop it, or aim it at a channel
 * main does not register, and every unit test on either side stays green while
 * the shipped build answers "no handler registered". That is what
 * `test/onboarding-local-state-preload-hop.test.ts` exists to catch.
 */
export function createOnboardingLocalStateDesktopApi(
  ipcRendererLike: IpcInvokeLike
) {
  return {
    getOnboardingLocalState: (payload?: { attemptId?: string }) =>
      ipcRendererLike.invoke(ONBOARDING_LOCAL_STATE_CHANNEL, payload),
  };
}
