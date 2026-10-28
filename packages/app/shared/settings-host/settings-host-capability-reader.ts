import type { SettingsHostCapabilities } from "@repo/api/src/types/settings-host-capabilities";
import {
  SettingsLocalDeviceReason,
  settingsLocalDeviceError,
} from "@repo/api/src/types/settings-host-capabilities";
import type { SettingsHostAdapter } from "./settings-host-adapter";
import { toSettingsHostCapabilities } from "./settings-host-adapter";

/**
 * ISS-8379 (PRD-691) — the scoped reader around a {@link SettingsHostAdapter}.
 *
 * A host read is asynchronous and the identity it is read for can change while
 * it is in flight: the user switches workspace, signs into another account, or
 * closes Settings. Applying a response that was requested for a different actor
 * is how a surface shows one identity's device under another's Settings, so
 * every response is checked against the scope and generation that were current
 * when it started, and a stale one is DISCARDED rather than folded in.
 *
 * Pure and React-free so each discard path is executable by a unit test.
 */

export type SettingsHostScope = {
  userId: string | null;
  organizationId: string | null;
};

export const SettingsHostReadOutcome = {
  /** The response is current and may be applied. */
  Applied: "applied",
  /** A newer read for the SAME scope started first. */
  Superseded: "superseded",
  /** The identity or workspace changed while this read was in flight. */
  ScopeChanged: "scope-changed",
  /** The reader was torn down while this read was in flight. */
  Disposed: "disposed",
} as const;

export type SettingsHostReadOutcome =
  (typeof SettingsHostReadOutcome)[keyof typeof SettingsHostReadOutcome];

export type SettingsHostReadResult =
  | {
      outcome: typeof SettingsHostReadOutcome.Applied;
      capabilities: SettingsHostCapabilities;
    }
  | {
      outcome: Exclude<
        SettingsHostReadOutcome,
        typeof SettingsHostReadOutcome.Applied
      >;
    };

export type SettingsHostCapabilityReader = {
  /** Start a read for `scope`; resolves with whether its answer still applies. */
  read: (scope: SettingsHostScope) => Promise<SettingsHostReadResult>;
  /**
   * Record a new active scope WITHOUT starting a read, so an identity or
   * workspace switch invalidates whatever is already in flight.
   */
  switchScope: (scope: SettingsHostScope) => void;
  /** Tear down: everything in flight is discarded and no further read runs. */
  dispose: () => void;
};

export function createSettingsHostCapabilityReader(
  adapter: SettingsHostAdapter
): SettingsHostCapabilityReader {
  let generation = 0;
  let activeScope: SettingsHostScope | null = null;
  let disposed = false;

  function beginGeneration(scope: SettingsHostScope): number {
    generation += 1;
    activeScope = scope;
    return generation;
  }

  async function read(
    scope: SettingsHostScope
  ): Promise<SettingsHostReadResult> {
    if (disposed) {
      return { outcome: SettingsHostReadOutcome.Disposed };
    }
    const startedGeneration = beginGeneration(scope);
    // The port contract says `readLocalDevice` settles rather than rejects; an
    // adapter that breaks it still degrades to a settled error state here
    // instead of propagating a rejection into a panel's render.
    const localDevice = await adapter
      .readLocalDevice()
      .catch(() =>
        settingsLocalDeviceError(SettingsLocalDeviceReason.ReadFailed)
      );
    if (disposed) {
      return { outcome: SettingsHostReadOutcome.Disposed };
    }
    if (generation !== startedGeneration) {
      return {
        outcome: isSameSettingsHostScope(activeScope, scope)
          ? SettingsHostReadOutcome.Superseded
          : SettingsHostReadOutcome.ScopeChanged,
      };
    }
    return {
      outcome: SettingsHostReadOutcome.Applied,
      capabilities: toSettingsHostCapabilities(adapter.host, localDevice),
    };
  }

  return {
    read,
    switchScope: (scope) => {
      beginGeneration(scope);
    },
    dispose: () => {
      disposed = true;
      generation += 1;
      activeScope = null;
    },
  };
}

export function isSameSettingsHostScope(
  left: SettingsHostScope | null,
  right: SettingsHostScope | null
): boolean {
  if (!(left && right)) {
    return left === right;
  }
  return (
    left.userId === right.userId && left.organizationId === right.organizationId
  );
}
