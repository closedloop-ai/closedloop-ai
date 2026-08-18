/**
 * FEA-4048 — native-by-default scheduling broker.
 *
 * The broker's `decideRoute` was flipped so a task whose primary harness has a
 * real native scheduler routes NATIVE by default, with the daemon cascade as the
 * fallback (the inverse of the FEA-3816 default). `defaultTaskRoute` maps that
 * derived `ScheduleRoute` onto the persisted `TaskRoute` the store keeps, so a
 * Claude-primary night-crew task lands on `claude-scheduled-tasks` by default.
 *
 * These assert the routing DECISION only. The executable safety invariant — an
 * unconfirmed native default still runs locally, a confirmed native slot never
 * double-fires — is a daemon property, covered in daemon.test.ts against
 * `hasConfirmedNativeOwner`.
 */
import { describe, expect, it } from "vitest";
import {
  decideRoute,
  defaultTaskRoute,
  primaryHarness,
  type RoutableTask,
  ScheduleRoute,
} from "../src/broker.js";
import type { HarnessRegistry } from "../src/harness/index.js";
import type { Harness } from "../src/harness/types.js";
import {
  AVAILABLE_MODELS,
  type CascadeStep,
  DEFAULT_MODEL,
  HarnessName,
  NativeSchedule,
  TaskRoute,
} from "../src/model.js";

/** The daemon's default cascade order (codex-first, matching the CLI). */
const DEFAULT_CASCADE: readonly CascadeStep[] = [
  { harness: HarnessName.Codex },
  { harness: HarnessName.Claude },
  { harness: HarnessName.Opencode },
];

/** A routable task carrying just the cascade the broker reads. */
function routable(cascade: CascadeStep[]): RoutableTask {
  return { harnessCascade: cascade };
}

/**
 * A minimal `Harness` stub carrying only the capability the broker reads. The
 * unused surface (`isAvailable`/`listModels`/`run`) is stubbed so the object is a
 * complete `Harness` — no cast needed at the call site.
 */
function stubHarness(
  name: HarnessName,
  nativeSchedule: NativeSchedule
): Harness {
  return {
    name,
    capabilities: {
      nativeSchedule,
      availableModels: AVAILABLE_MODELS[name],
      defaultModel: DEFAULT_MODEL[name],
    },
    isAvailable: () => Promise.resolve(true),
    listModels: () => Promise.resolve(AVAILABLE_MODELS[name]),
    run: () =>
      Promise.resolve({
        ok: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 0,
        outputTail: "",
      }),
  };
}

/** A full registry where codex is (contrary to the static map) native-capable. */
function registryWithNativeCodex(): HarnessRegistry {
  return {
    [HarnessName.Claude]: stubHarness(
      HarnessName.Claude,
      NativeSchedule.ClaudeScheduledTasks
    ),
    [HarnessName.Codex]: stubHarness(
      HarnessName.Codex,
      NativeSchedule.ClaudeScheduledTasks
    ),
    [HarnessName.Opencode]: stubHarness(
      HarnessName.Opencode,
      NativeSchedule.None
    ),
  };
}

/** A registry where the claude head reports a CLOUD routine capability. */
function registryWithCloudClaude(): HarnessRegistry {
  return {
    [HarnessName.Claude]: stubHarness(
      HarnessName.Claude,
      NativeSchedule.CloudRoutine
    ),
    [HarnessName.Codex]: stubHarness(HarnessName.Codex, NativeSchedule.None),
    [HarnessName.Opencode]: stubHarness(
      HarnessName.Opencode,
      NativeSchedule.None
    ),
  };
}

describe("decideRoute — native by default (FEA-4048)", () => {
  it("routes a native-capable (claude) primary harness NATIVE by default", () => {
    const decision = decideRoute(
      routable([{ harness: HarnessName.Claude }]),
      DEFAULT_CASCADE
    );
    expect(decision.route).toBe(ScheduleRoute.ClaudeNative);
  });

  it("routes a codex-primary task to the daemon cascade (no native scheduler)", () => {
    const decision = decideRoute(
      routable([{ harness: HarnessName.Codex }]),
      DEFAULT_CASCADE
    );
    expect(decision.route).toBe(ScheduleRoute.DaemonCascade);
  });

  it("routes an opencode-primary task to the daemon cascade", () => {
    const decision = decideRoute(
      routable([{ harness: HarnessName.Opencode }]),
      DEFAULT_CASCADE
    );
    expect(decision.route).toBe(ScheduleRoute.DaemonCascade);
  });

  it("falls back to the default cascade head when the task has no per-task cascade", () => {
    // Empty per-task cascade ⇒ the default cascade head (codex) decides ⇒ daemon,
    // NOT a phantom native route. Proves the default cascade is honored.
    const decision = decideRoute(routable([]), DEFAULT_CASCADE);
    expect(decision.route).toBe(ScheduleRoute.DaemonCascade);
    expect(primaryHarness(routable([]), DEFAULT_CASCADE)).toBe(
      HarnessName.Codex
    );
  });

  it("routes to the daemon when there is no head harness at all", () => {
    const decision = decideRoute(routable([]), []);
    expect(decision.route).toBe(ScheduleRoute.DaemonCascade);
  });

  it("forceDaemon keeps a native-capable task daemon-owned (opt-out)", () => {
    const decision = decideRoute(
      routable([{ harness: HarnessName.Claude }]),
      DEFAULT_CASCADE,
      { forceDaemon: true }
    );
    expect(decision.route).toBe(ScheduleRoute.DaemonCascade);
  });

  it("prefers an injected registry's live capability over the static map", () => {
    // A registry that reports codex as natively schedulable must flip codex to
    // native, proving the registry wins over the pure capability lookup.
    const decision = decideRoute(
      routable([{ harness: HarnessName.Codex }]),
      DEFAULT_CASCADE,
      { registry: registryWithNativeCodex() }
    );
    expect(decision.route).toBe(ScheduleRoute.ClaudeNative);
  });
});

describe("defaultTaskRoute — persisted route mapping (FEA-4048)", () => {
  it("maps a claude-primary task to the native claude-scheduled-tasks route", () => {
    expect(
      defaultTaskRoute(
        routable([{ harness: HarnessName.Claude }]),
        DEFAULT_CASCADE
      )
    ).toBe(TaskRoute.ClaudeScheduledTasks);
  });

  it("maps a codex-primary task to local-cascade (daemon)", () => {
    expect(
      defaultTaskRoute(
        routable([{ harness: HarnessName.Codex }]),
        DEFAULT_CASCADE
      )
    ).toBe(TaskRoute.LocalCascade);
  });

  it("maps a forceDaemon claude-primary task to local-cascade", () => {
    expect(
      defaultTaskRoute(
        routable([{ harness: HarnessName.Claude }]),
        DEFAULT_CASCADE,
        { forceDaemon: true }
      )
    ).toBe(TaskRoute.LocalCascade);
  });

  it("never derives the opt-in-only claude-routine (cloud) route", () => {
    // No harness capability maps to the cloud routine, so the derived persisted
    // route is only ever native-local or the daemon route.
    for (const harness of Object.values(HarnessName)) {
      const route = defaultTaskRoute(routable([{ harness }]), DEFAULT_CASCADE);
      expect(route).not.toBe(TaskRoute.ClaudeRoutine);
    }
  });

  it("carries the concrete native capability on the decision", () => {
    // The decision distinguishes the LOCAL scheduled-tasks capability from a
    // cloud routine — so the persisted-route mapping can key off the concrete
    // capability rather than the collapsed ScheduleRoute.
    const local = decideRoute(
      routable([{ harness: HarnessName.Claude }]),
      DEFAULT_CASCADE
    );
    expect(local.nativeSchedule).toBe(NativeSchedule.ClaudeScheduledTasks);
    const daemon = decideRoute(
      routable([{ harness: HarnessName.Codex }]),
      DEFAULT_CASCADE
    );
    expect(daemon.nativeSchedule).toBe(NativeSchedule.None);
  });

  it("maps a CLOUD-routine capability to local-cascade, never the LOCAL native writer", () => {
    // Regression (FEA-4048): decideRoute collapses every native capability into
    // ScheduleRoute.ClaudeNative, so a cloud-capable head must NOT be mapped to
    // `claude-scheduled-tasks` (the LOCAL scheduled_tasks.json writer). Cloud is
    // opt-in only, so it falls back to the daemon route.
    const decision = decideRoute(
      routable([{ harness: HarnessName.Claude }]),
      DEFAULT_CASCADE,
      { registry: registryWithCloudClaude() }
    );
    expect(decision.route).toBe(ScheduleRoute.ClaudeNative);
    expect(decision.nativeSchedule).toBe(NativeSchedule.CloudRoutine);
    expect(
      defaultTaskRoute(
        routable([{ harness: HarnessName.Claude }]),
        DEFAULT_CASCADE,
        { registry: registryWithCloudClaude() }
      )
    ).toBe(TaskRoute.LocalCascade);
  });
});
