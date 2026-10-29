import { useFeatureFlag } from "@repo/analytics/client";
import { FeatureFlagged as PortFeatureFlagged } from "@repo/app/shared/feature-flags/feature-flagged";
import {
  useFeatureFlagEnabled,
  useFeatureFlagResolved,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { act, cleanup, render } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider as WithPort } from "@/__tests__/helpers/web-feature-flag-provider";

/**
 * ISS-11411. The 18 `apps/app` files that read a flag straight from the
 * analytics SDK moved to the port. On web the port resolves through
 * `posthogFeatureFlagAdapter`, so a migrated read is only behavior-preserving if
 * the adapter answers exactly what the old read answered, in the SAME render,
 * for every flag state, including the unresolved one and the frame where an
 * unresolved flag lands.
 *
 * The one mechanical difference is the number of SDK hook instances: an old
 * three-state site read `useFeatureFlag` once, and its port form reads it twice
 * (`useFeatureFlagEnabled` and `useFeatureFlagResolved`). posthog-js keeps a
 * `useState` copy per instance, so the two could only disagree if one updated
 * in a render the other did not. These cases drive both shapes through the
 * same transitions against a stand-in that mirrors the shipped hook, and
 * compare every render; `packages/analytics/feature-flag-read-agreement.test.tsx`
 * runs the same comparison against the real posthog-js hook.
 *
 * The second block holds the port `FeatureFlagged` to the frames the analytics
 * `FeatureFlagged` painted. ISS-11786 retired that component, so the frames are
 * recorded in `RECORDED_ANALYTICS_FRAMES` instead of rendered beside the port.
 * They were recorded by running both gates at commit 678cb828b7, where they
 * painted the same sequence in every case below. The table is a frozen
 * expectation: changing a row changes what users see behind a flag gate, and
 * needs its own ticket.
 */

const FLAG = "iss-11411-parity-probe";

type SdkResult =
  | { key: string; enabled: boolean; variant: undefined; payload: undefined }
  | undefined;

const posthog = vi.hoisted(() => {
  // `@repo/analytics/client` picks its PostHog binding once, at module scope,
  // off this key, so it has to exist before that module is evaluated. The
  // prior value is restored in `afterAll`.
  const priorPostHogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_iss11411_parity";
  const listeners = new Set<() => void>();
  const state: { value: SdkResult } = { value: undefined };
  return {
    priorPostHogKey,
    listeners,
    state,
    /** posthog-js fires every `onFeatureFlags` handler in one synchronous loop. */
    deliver(value: SdkResult) {
      state.value = value;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
});

vi.mock("@posthog/next", async () => {
  const { useEffect, useState } = await import("react");
  return {
    /**
     * Mirrors posthog-js/react 1.359.1 `useFeatureFlagResult`, the copy
     * `@posthog/next` 0.1.0 pins and re-exports as `useFeatureFlag`: each call
     * holds its own state, seeded from the client during render and refreshed
     * from its own `onFeatureFlags` subscription.
     */
    useFeatureFlag: (flag: string) => {
      const [result, setResult] = useState<SdkResult>(() =>
        flag === FLAG ? posthog.state.value : undefined
      );
      useEffect(() => {
        const listener = () =>
          setResult(flag === FLAG ? posthog.state.value : undefined);
        posthog.listeners.add(listener);
        return () => {
          posthog.listeners.delete(listener);
        };
      }, [flag]);
      return result;
    },
    usePostHog: () => ({
      onFeatureFlags: () => () => {},
      identify: () => {},
      capture: () => undefined,
      reset: () => {},
    }),
  };
});

afterAll(() => {
  if (posthog.priorPostHogKey === undefined) {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = posthog.priorPostHogKey;
  }
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  posthog.listeners.clear();
  posthog.state.value = undefined;
});

const RESOLVED_ON: SdkResult = {
  key: FLAG,
  enabled: true,
  variant: undefined,
  payload: undefined,
};
const RESOLVED_OFF: SdkResult = {
  key: FLAG,
  enabled: false,
  variant: undefined,
  payload: undefined,
};

type Frame = {
  enabled: boolean;
  resolved: boolean;
};

/** Both read shapes in one component, so every commit records both answers. */
function ReadProbe({
  legacyFrames,
  portFrames,
}: {
  legacyFrames: Frame[];
  portFrames: Frame[];
}) {
  const legacy = useFeatureFlag(FLAG);
  const portEnabled = useFeatureFlagEnabled(FLAG);
  const portResolved = useFeatureFlagResolved(FLAG);
  legacyFrames.push({
    enabled: legacy?.enabled === true,
    resolved: legacy !== undefined,
  });
  portFrames.push({ enabled: portEnabled, resolved: portResolved });
  return null;
}

async function landAfterTask(value: SdkResult) {
  // Delivered from a timer task, not inside a React event, the way a `/flags`
  // response lands.
  vi.useFakeTimers();
  await act(async () => {
    setTimeout(() => posthog.deliver(value), 0);
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe("port reads match the SDK read render by render", () => {
  it.each([
    ["unresolved, then resolved on", undefined, RESOLVED_ON],
    ["unresolved, then resolved off", undefined, RESOLVED_OFF],
    ["resolved off, then reloaded on", RESOLVED_OFF, RESOLVED_ON],
    ["resolved on, then reloaded off", RESOLVED_ON, RESOLVED_OFF],
  ])("%s", async (_name, first, second) => {
    posthog.state.value = first;
    const legacyFrames: Frame[] = [];
    const portFrames: Frame[] = [];

    render(
      <WithPort>
        <ReadProbe legacyFrames={legacyFrames} portFrames={portFrames} />
      </WithPort>
    );
    const firstRenderCount = portFrames.length;
    await landAfterTask(second);

    expect(portFrames).toEqual(legacyFrames);
    // The flag did land in a later render, so the comparison covered the
    // landing frame and not only the first one.
    expect(portFrames.length).toBeGreaterThan(firstRenderCount);
    expect(portFrames[0]).toEqual({
      enabled: first?.enabled === true,
      resolved: first !== undefined,
    });
    expect(portFrames.at(-1)).toEqual({
      enabled: second?.enabled === true,
      resolved: second !== undefined,
    });
  });
});

function PortGate({ fallback }: { fallback?: ReactNode }) {
  return (
    <div data-testid="port">
      <PortFeatureFlagged fallback={fallback} flag={FLAG}>
        gated child
      </PortFeatureFlagged>
    </div>
  );
}

function renderedText(container: HTMLElement): string {
  return (
    container.querySelector('[data-testid="port"]')?.textContent ?? "<missing>"
  );
}

function collapseRepeats(frames: string[]): string[] {
  return frames.filter((frame, index) => frame !== frames[index - 1]);
}

type RecordedFrames = {
  /**
   * The text each commit painted before the flag landed, consecutive repeats
   * collapsed, so an extra identical commit from a React upgrade is not a
   * difference but a changed or reordered frame is.
   */
  beforeLanding: string[];
  /** The text every commit from the landing onward painted. */
  afterLanding: string;
};

const PENDING = "pending";
const CHILD = "gated child";

/**
 * Recorded from the analytics `FeatureFlagged` at 678cb828b7 (ISS-11786). The
 * first frame is the client mount commit, which paints nothing because the gate
 * waits for its mount effect; the second is the mounted branch.
 */
const RECORDED_ANALYTICS_FRAMES: [
  name: string,
  first: SdkResult,
  second: SdkResult,
  fallback: string | undefined,
  frames: RecordedFrames,
][] = [
  [
    "unresolved, then on, with a fallback",
    undefined,
    RESOLVED_ON,
    PENDING,
    { beforeLanding: ["", PENDING], afterLanding: CHILD },
  ],
  [
    "unresolved, then on, without a fallback",
    undefined,
    RESOLVED_ON,
    undefined,
    { beforeLanding: [""], afterLanding: CHILD },
  ],
  [
    "unresolved, then off, with a fallback",
    undefined,
    RESOLVED_OFF,
    PENDING,
    { beforeLanding: ["", PENDING], afterLanding: PENDING },
  ],
  [
    "unresolved, then off, without a fallback",
    undefined,
    RESOLVED_OFF,
    undefined,
    { beforeLanding: [""], afterLanding: "" },
  ],
  [
    "off, then reloaded on, with a fallback",
    RESOLVED_OFF,
    RESOLVED_ON,
    PENDING,
    { beforeLanding: ["", PENDING], afterLanding: CHILD },
  ],
  [
    "off, then reloaded on, without a fallback",
    RESOLVED_OFF,
    RESOLVED_ON,
    undefined,
    { beforeLanding: [""], afterLanding: CHILD },
  ],
  [
    "on, then reloaded off, with a fallback",
    RESOLVED_ON,
    RESOLVED_OFF,
    PENDING,
    { beforeLanding: ["", CHILD], afterLanding: PENDING },
  ],
  [
    "on, then reloaded off, without a fallback",
    RESOLVED_ON,
    RESOLVED_OFF,
    undefined,
    { beforeLanding: ["", CHILD], afterLanding: "" },
  ],
];

describe("port FeatureFlagged paints the recorded analytics FeatureFlagged frames", () => {
  it.each([
    ["unresolved", undefined],
    ["resolved off", RESOLVED_OFF],
    ["resolved on", RESOLVED_ON],
  ])("renders nothing on the server when %s", (_name, value) => {
    posthog.state.value = value;

    const html = renderToString(
      <WithPort>
        <PortGate fallback={PENDING} />
      </WithPort>
    );

    expect(html).toBe('<div data-testid="port"></div>');
  });

  it.each(RECORDED_ANALYTICS_FRAMES)(
    "paints the recorded frames when %s",
    async (_name, first, second, fallback, recorded) => {
      posthog.state.value = first;
      const host = document.body.appendChild(document.createElement("div"));
      const painted: string[] = [];
      render(
        <WithPort>
          <Profiler id="gate" onRender={() => painted.push(renderedText(host))}>
            <PortGate fallback={fallback} />
          </Profiler>
        </WithPort>,
        { container: host }
      );
      const landingIndex = painted.length;

      await landAfterTask(second);

      expect(collapseRepeats(painted.slice(0, landingIndex))).toEqual(
        recorded.beforeLanding
      );
      // The landing commit itself paints the new branch: no commit after the
      // flag lands may still show the old one.
      const afterLanding = painted.slice(landingIndex);
      expect(afterLanding.length).toBeGreaterThan(0);
      for (const frame of afterLanding) {
        expect(frame).toBe(recorded.afterLanding);
      }
    }
  );
});
