import type { ReactNode } from "react";
import { AgentMonitorRuntimeStatusKind } from "../../shared/agent-monitor-status";
import { __resetRuntimeStatusPollForTests } from "../hooks/use-ingest-progress";
import { AgentMonitorDbAheadBanner } from "./agent-monitor-db-ahead-banner";

/**
 * ISS-4841 (wongk review on PR #4186): the AppShell degraded-state banners are
 * the screens nobody lays eyes on again until they fire in the wild. This one is
 * the hardest to reach at runtime - it needs a local SQLite store written by a
 * NEWER Desktop build than the one you are running - so the canvas is the only
 * practical place to look at it.
 *
 * Every branch of the banner is pinned here, including the four that render
 * nothing. A silent state is still a state: this banner claims the whole local
 * runtime is dead, so "stays quiet unless the runtime really is DB-ahead" is the
 * property most worth being able to see.
 *
 * Follows the `settings/global-sandbox-card.stories.tsx` pattern: install the
 * narrow `window.desktopApi` slice the component reads (here, the shared
 * runtime-status poll's `getRuntimeStatus`) so Storybook renders the Electron
 * wrapper with no main process behind it.
 */
const meta = {
  title: "Composites/App Shell/Agent Monitor DB Ahead Banner",
  component: AgentMonitorDbAheadBanner,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/**
 * The degraded state: the local store carries a migration this build does not
 * know about, so parsing and cloud sync are dead until the app is updated. The
 * banner leads with what stopped, names the cause plainly, and ends in the one
 * control that recovers it.
 */
export const DbAhead = {
  render: () =>
    renderScenario({
      caption: "DB ahead of the app - the banner's only visible state.",
      status: {
        agentMonitor: {
          kind: AgentMonitorRuntimeStatusKind.Failed,
          dbAhead: true,
          reason:
            "The local Agent Monitor database was created by a newer version.",
        },
      },
    }),
};

/** The healthy runtime. The banner must not claim sync is broken. */
export const Ready = {
  render: () =>
    renderScenario({
      caption: "Runtime ready - no banner.",
      status: {
        agentMonitor: {
          kind: AgentMonitorRuntimeStatusKind.Ready,
          dbAhead: false,
          reason: null,
        },
      },
    }),
};

/**
 * The runtime failed for some other reason. That failure has its own surface, so
 * this banner stays out of the way rather than blaming an update the user does
 * not need.
 */
export const OtherFailure = {
  render: () =>
    renderScenario({
      caption: "Runtime failed, but not DB-ahead - no banner.",
      status: {
        agentMonitor: {
          kind: AgentMonitorRuntimeStatusKind.Failed,
          dbAhead: false,
          reason: "The Agent Monitor could not start.",
        },
      },
    }),
};

/**
 * A version-skewed payload claiming `dbAhead` on a READY runtime. The parser
 * drops the claim, so a malformed status can never light up the most severe
 * banner in the app.
 */
export const ReadyClaimingDbAhead = {
  render: () =>
    renderScenario({
      caption: "Malformed payload (ready + dbAhead) - no banner.",
      status: {
        agentMonitor: {
          kind: AgentMonitorRuntimeStatusKind.Ready,
          dbAhead: true,
          reason: "should be ignored",
        },
      },
    }),
};

/**
 * An older main process that does not send the field at all. Absent is not the
 * same as broken, so the banner stays hidden.
 */
export const FieldAbsent = {
  render: () =>
    renderScenario({
      caption: "Older main process, field absent - no banner.",
      status: {},
    }),
};

type DbAheadScenario = {
  /** What this story is showing, for the reader of the canvas. */
  caption: string;
  /** The raw runtime-status payload the shared poll resolves. */
  status: unknown;
};

function installRuntimeStatusFixture(status: unknown): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      checkForUpdate: () => Promise.resolve(),
      getRuntimeStatus: () => Promise.resolve(status),
    },
    writable: true,
  });
}

function renderScenario({ caption, status }: DbAheadScenario): ReactNode {
  // The runtime-status poll is a module-level singleton that replays its last
  // snapshot to late subscribers, and this banner LATCHES on the first terminal
  // verdict it sees. Without a reset, switching stories would replay the
  // previous story's status and the canvas would lie about which state it is
  // showing. Storybook is a harness, so it uses the same reset the tests do.
  __resetRuntimeStatusPollForTests();
  installRuntimeStatusFixture(status);
  return (
    <div className="flex flex-col">
      <AgentMonitorDbAheadBanner />
      <p className="px-4 py-3 text-muted-foreground text-sm">{caption}</p>
    </div>
  );
}
