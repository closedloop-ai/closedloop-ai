import type { SandboxInspectResult } from "../../types/desktop-api";
import { GlobalSandboxSection } from "./global-sandbox-card";

/**
 * ISS-4577 (wongk story review): the global sandbox editor has a real spread of
 * visual states worth pinning on a canvas — the settled default, the unset
 * ("Not set") state, the loading state before settings resolve, a risky-root
 * error, a missing-directory error, and the git-repo hint. Each story installs
 * the narrow `window.desktopApi` slice the section reads so Storybook can render
 * the Electron wrapper without a running main process, and seeds the section's
 * initial value through `settings.sandboxBaseDirectory` so the state is
 * deterministic (the inline validity feedback resolves from the fixture's
 * `inspectSandboxPath`).
 */
const SETTLED_SANDBOX = "/workspace/current";
const RISKY_SANDBOX = "/";
const MISSING_SANDBOX = "/workspace/gone";
const GIT_REPO_SANDBOX = "/workspace/one-repo";

type SandboxApiScenario = {
  /** How `inspectSandboxPath` resolves for whatever path the section probes. */
  inspect: (path: string) => SandboxInspectResult;
};

/**
 * A settings form for the one folder your AI agents are allowed to read and
 * write in on this machine: a text field, a Browse button that opens a
 * folder picker, and inline warnings about risky or missing folders. Use it
 * for the machine-wide default sandbox folder, a specific gateway profile
 * can still point somewhere else and only inherits this value when it sets
 * none of its own. While the saved setting is still loading, the field shows
 * disabled with no placeholder text rather than an empty box that could be
 * mistaken for a confirmed empty folder, and Save stays off until the path
 * has changed and passed validation.
 */
const meta = {
  title: "Composites/Compute/Global Sandbox Section",
  component: GlobalSandboxSection,
  tags: ["autodocs"],
  argTypes: {
    settings: {
      control: "object",
      description:
        "The resolved desktop settings record, or null while the async load has not returned. Null is not an empty value: the section must not assert a sandbox boundary it does not yet know.",
    },
    onSettingsChange: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    onSettingsChange: () => undefined,
    settings: { sandboxBaseDirectory: SETTLED_SANDBOX },
  },
  parameters: {
    layout: "centered",
  },
};

export default meta;

/**
 * The common case: a configured, existing, non-risky folder. Save is disabled
 * (the field matches the stored value) until the path is edited.
 */
export const Settled = {
  render: () => renderScenario(SETTLED_SANDBOX, healthyScenario()),
};

/**
 * The stored value is empty once settings resolve: the field is empty (no
 * misleading grey placeholder path) and the helper line reads "Not set".
 */
export const NotSet = {
  render: () => renderScenario("", healthyScenario()),
};

/**
 * Settings have not resolved yet (`settings === null`): the field is held
 * disabled with no placeholder so the section never asserts a sandbox boundary
 * it does not yet know.
 */
export const Loading = {
  render: () => renderScenario(null, healthyScenario()),
};

/** A risky root (e.g. `/`) surfaces the destructive risky-root error. */
export const RiskyRoot = {
  render: () =>
    renderScenario(RISKY_SANDBOX, {
      inspect: (path) => ({
        ...baseInspect(path),
        isRisky: true,
      }),
    }),
};

/** A path that does not exist on disk surfaces the missing-directory error. */
export const MissingDirectory = {
  render: () =>
    renderScenario(MISSING_SANDBOX, {
      inspect: (path) => ({
        ...baseInspect(path),
        exists: false,
      }),
    }),
};

/** A folder that is itself a git repo shows the muted parent-scope hint. */
export const GitRepoHint = {
  render: () =>
    renderScenario(GIT_REPO_SANDBOX, {
      inspect: (path) => ({
        ...baseInspect(path),
        isGitRepo: true,
        suggestedPath: "/workspace",
      }),
    }),
};

function baseInspect(path: string): SandboxInspectResult {
  return {
    path,
    isGitRepo: false,
    suggestedPath: undefined,
    isRisky: false,
    exists: true,
  };
}

function healthyScenario(): SandboxApiScenario {
  return { inspect: baseInspect };
}

function installDesktopApiFixture(scenario: SandboxApiScenario): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      inspectSandboxPath: (path: string) =>
        Promise.resolve(scenario.inspect(path)),
      pickSandboxDirectory: () => Promise.resolve(null),
      updateSettings: (patch: Record<string, unknown>) =>
        Promise.resolve({ ...patch, savedConfigs: [] }),
    },
  });
}

function renderScenario(
  storedSandbox: string | null,
  scenario: SandboxApiScenario
) {
  installDesktopApiFixture(scenario);
  const settings =
    storedSandbox === null ? null : { sandboxBaseDirectory: storedSandbox };
  return (
    <div className="w-[28rem] rounded-xl border bg-card p-4">
      <GlobalSandboxSection
        onSettingsChange={() => undefined}
        settings={settings}
      />
    </div>
  );
}
