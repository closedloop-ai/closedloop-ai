import { describe, expect, it } from "vitest";
import {
  actionForState,
  applyCellAction,
  CellAction,
  CellState,
  ComponentKind,
  cellStateFor,
  DEMO_COMPONENT,
  DEMO_TARGETS,
  Harness,
  isInstalledState,
  needsActionState,
  type PackComponent,
  rollupFor,
  type Target,
  type TargetHarnesses,
} from "./mock";

const hookComponent: PackComponent = {
  id: "cmp-test-hook",
  name: "test-hook",
  kind: ComponentKind.Hook,
  pack: "Test",
  version: "1.0.0",
  description: "",
};

const skillComponent: PackComponent = {
  ...hookComponent,
  id: "cmp-test-skill",
  kind: ComponentKind.Skill,
};

const allHarnesses: TargetHarnesses = {
  [Harness.Claude]: true,
  [Harness.Codex]: true,
  [Harness.OpenCode]: true,
};

const targetWith = (
  cells: Target["cells"],
  harnesses = allHarnesses
): Target => ({
  id: "tgt-test",
  name: "test-box",
  platform: "linux",
  online: true,
  harnesses,
  cells,
});

describe("cellStateFor — support intersected with target availability", () => {
  it("marks a harness the component kind cannot run as unsupported", () => {
    // Codex has no hook runtime, so a Hook is unsupported on Codex regardless
    // of what the target reports.
    const target = targetWith({ [Harness.Codex]: CellState.Installed });
    expect(cellStateFor(hookComponent, target, Harness.Codex)).toBe(
      CellState.Unsupported
    );
  });

  it("supports Skills on Codex (matches the desktop scanner)", () => {
    const target = targetWith({ [Harness.Codex]: CellState.Installed });
    expect(cellStateFor(skillComponent, target, Harness.Codex)).toBe(
      CellState.Installed
    );
  });

  it("marks a supported harness that is absent on the target as unsupported", () => {
    // Skill supports OpenCode, but this box has no OpenCode runtime, so the cell
    // reads unsupported rather than defaulting to not-installed.
    const target = targetWith(
      {},
      { [Harness.Claude]: true, [Harness.Codex]: true }
    );
    expect(cellStateFor(skillComponent, target, Harness.OpenCode)).toBe(
      CellState.Unsupported
    );
  });

  it("defaults a supported+present harness with no stored state to not-installed", () => {
    const target = targetWith({});
    expect(cellStateFor(skillComponent, target, Harness.Claude)).toBe(
      CellState.NotInstalled
    );
  });
});

describe("rollup counting — update-available counts as installed", () => {
  it("counts an updatable cell in both installed and needs-action", () => {
    const targets: Target[] = [
      targetWith({ [Harness.Claude]: CellState.Installed }),
      targetWith({ [Harness.Claude]: CellState.Updatable }),
      targetWith({ [Harness.Claude]: CellState.NotInstalled }),
    ];
    const rollup = rollupFor(skillComponent, targets, Harness.Claude);
    // 2 have an installation (one current, one behind), so installed = 2.
    expect(rollup.installed).toBe(2);
    // The behind one and the not-installed one both need action.
    expect(rollup.needsAction).toBe(2);
    expect(rollup.total).toBe(3);
  });

  it("counts the seeded Claude column as 3 of 4 installed", () => {
    // linux-build-02 is Updatable (installed-but-behind), parkers-mbp and
    // win-desktop-01 are Installed; mbp-ci-runner is offline/unknown. So three
    // of the four targets have an installation.
    const rollup = rollupFor(DEMO_COMPONENT, DEMO_TARGETS, Harness.Claude);
    expect(rollup.installed).toBe(3);
    expect(rollup.total).toBe(4);
  });

  it("reports unsupported harnesses as not supported", () => {
    const rollup = rollupFor(DEMO_COMPONENT, DEMO_TARGETS, Harness.Codex);
    // DEMO_COMPONENT is a Hook; Codex can't run hooks.
    expect(rollup.supported).toBe(false);
  });
});

describe("isInstalledState / needsActionState", () => {
  it("treats installed and updatable as installed states", () => {
    expect(isInstalledState(CellState.Installed)).toBe(true);
    expect(isInstalledState(CellState.Updatable)).toBe(true);
    expect(isInstalledState(CellState.NotInstalled)).toBe(false);
  });

  it("treats not-installed, updatable, and failed as needing action", () => {
    expect(needsActionState(CellState.NotInstalled)).toBe(true);
    expect(needsActionState(CellState.Updatable)).toBe(true);
    expect(needsActionState(CellState.Failed)).toBe(true);
    expect(needsActionState(CellState.Installed)).toBe(false);
    expect(needsActionState(CellState.Converting)).toBe(false);
  });
});

describe("applyCellAction — stale repeats do not invert", () => {
  it("installs a not-installed cell", () => {
    expect(applyCellAction(CellState.NotInstalled, CellAction.Install)).toBe(
      CellState.Installed
    );
  });

  it("ignores a second Install once the cell is already installed", () => {
    // The double-click bug: a stale repeat must not toggle Installed back off.
    const afterFirst = applyCellAction(
      CellState.NotInstalled,
      CellAction.Install
    );
    const afterSecond = applyCellAction(afterFirst, CellAction.Install);
    expect(afterSecond).toBe(CellState.Installed);
  });

  it("updates an updatable cell to installed", () => {
    expect(applyCellAction(CellState.Updatable, CellAction.Update)).toBe(
      CellState.Installed
    );
  });

  it("removes an installed cell only for a Remove action", () => {
    expect(applyCellAction(CellState.Installed, CellAction.Remove)).toBe(
      CellState.NotInstalled
    );
    expect(applyCellAction(CellState.Installed, CellAction.Install)).toBe(
      CellState.Installed
    );
  });

  it("retries a failed cell into installed", () => {
    expect(applyCellAction(CellState.Failed, CellAction.Retry)).toBe(
      CellState.Installed
    );
  });
});

describe("actionForState", () => {
  it("offers install / update / remove / retry for actionable states", () => {
    expect(actionForState(CellState.NotInstalled)).toBe(CellAction.Install);
    expect(actionForState(CellState.Updatable)).toBe(CellAction.Update);
    expect(actionForState(CellState.Installed)).toBe(CellAction.Remove);
    expect(actionForState(CellState.Failed)).toBe(CellAction.Retry);
  });

  it("offers no action for terminal / blocked states", () => {
    expect(actionForState(CellState.Converting)).toBeNull();
    expect(actionForState(CellState.Unsupported)).toBeNull();
    expect(actionForState(CellState.OfflineUnknown)).toBeNull();
  });
});
