/**
 * Test-body helpers for the `loop-desktop.ts` dispatch suites.
 *
 * Kept apart from `loop-desktop-dispatch.test-mocks.ts` because these reach
 * into the mocked `desktopCommandStore`. That module is consumed by the suites'
 * `vi.mock` factories, so importing a mocked module from it would be a cycle:
 * the factory for `@/lib/desktop-command-store` would await a module that
 * imports `@/lib/desktop-command-store`.
 */

import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import { vi } from "vitest";
import { DEFAULT_COMMAND_ID } from "@/__tests__/support/loops/loop-desktop-dispatch.test-mocks";
import { desktopCommandStore } from "@/lib/desktop-command-store";

/**
 * Reinstate the default `createCommand` result.
 *
 * The commandId-replay cases swap in a per-call minting implementation so their
 * assertions are able to fail. `restoreAllMocks` does not undo a
 * `mockImplementation` on a `vi.fn()` that was configured in a module factory,
 * so the default has to be re-established by whoever depends on it rather than
 * cleaned up by whoever replaced it.
 */
export function stubDefaultCreateCommand(): void {
  vi.mocked(desktopCommandStore.createCommand).mockResolvedValue({
    command: { commandId: DEFAULT_COMMAND_ID },
    deduped: false,
  } as Awaited<ReturnType<typeof desktopCommandStore.createCommand>>);
}

/**
 * Mint a distinct commandId per `createCommand` call, and record the ids.
 *
 * Replay assertions compare what reached the wire against what was minted; with
 * the suite-wide fixed id a production path that re-minted per attempt would
 * still put the same string on the wire twice and the assertion would not fail.
 */
export function trackMintedCommandIds(): string[] {
  const mintedCommandIds: string[] = [];
  vi.mocked(desktopCommandStore.createCommand).mockImplementation(
    (_computeTargetId: string, _input: CreateDesktopCommandInput) => {
      const commandId = `cmd-minted-${mintedCommandIds.length + 1}`;
      mintedCommandIds.push(commandId);
      return Promise.resolve({
        command: { commandId },
        deduped: false,
      } as Awaited<ReturnType<typeof desktopCommandStore.createCommand>>);
    }
  );
  return mintedCommandIds;
}
