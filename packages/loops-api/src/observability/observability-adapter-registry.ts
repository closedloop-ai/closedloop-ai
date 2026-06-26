import { LoopHarness } from "../desktop-request";
import type {
  HarnessObservabilityAdapter,
  ObservabilityAdapterContext,
  ObservabilityAdapterFactory,
} from "./adapter-contract";
import { createClaudeObservabilityAdapter } from "./claude-observability-adapter";
import { createCodexObservabilityAdapter } from "./codex-observability-adapter";

/**
 * Observability adapter registry (AC-003).
 *
 * Mirrors the `ClosedloopWebCommandPackFactory` adapter table shape: a single
 * map keyed by `LoopHarness` with a `supported`/`planned` status and (for
 * supported harnesses) a factory. Adding a placeholder harness requires only a
 * new entry here — no other code change (AC-003).
 */

export const ObservabilityAdapterStatus = {
  /** A factory exists; observability is produced for this harness. */
  Supported: "supported",
  /** Reserved harness with no factory yet (placeholder). */
  Planned: "planned",
} as const;
export type ObservabilityAdapterStatus =
  (typeof ObservabilityAdapterStatus)[keyof typeof ObservabilityAdapterStatus];

export type ObservabilityRegistryEntry = {
  harness: LoopHarness;
  status: ObservabilityAdapterStatus;
  /** Present iff status === Supported. */
  factory?: ObservabilityAdapterFactory;
  notes?: string;
};

const REGISTRY: Record<LoopHarness, ObservabilityRegistryEntry> = {
  [LoopHarness.Claude]: {
    harness: LoopHarness.Claude,
    status: ObservabilityAdapterStatus.Supported,
    factory: createClaudeObservabilityAdapter,
  },
  [LoopHarness.Codex]: {
    harness: LoopHarness.Codex,
    status: ObservabilityAdapterStatus.Supported,
    factory: createCodexObservabilityAdapter,
  },
  [LoopHarness.Cursor]: {
    harness: LoopHarness.Cursor,
    status: ObservabilityAdapterStatus.Planned,
    notes:
      "Registry placeholder; add a factory once Cursor exposes a stable stream format.",
  },
  [LoopHarness.OpenCode]: {
    harness: LoopHarness.OpenCode,
    status: ObservabilityAdapterStatus.Planned,
    notes:
      "Registry placeholder; add a factory once OpenCode stream semantics are finalized.",
  },
};

/** Inspect the registry entry for a harness (status + capabilities source). */
export function getObservabilityRegistryEntry(
  harness: LoopHarness
): ObservabilityRegistryEntry {
  return REGISTRY[harness];
}

/**
 * Select and construct the observability adapter for a harness, or `null` when
 * the harness has no supported factory (planned/placeholder). A `null` result
 * is the expected "no native observability for this harness yet" signal — the
 * caller falls back to the legacy path and emits nothing native.
 */
export function selectObservabilityAdapter(
  harness: LoopHarness,
  context: ObservabilityAdapterContext
): HarnessObservabilityAdapter | null {
  const entry = REGISTRY[harness];
  if (
    !entry ||
    entry.status !== ObservabilityAdapterStatus.Supported ||
    !entry.factory
  ) {
    return null;
  }
  return entry.factory(context);
}
