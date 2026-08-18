import { describe, expect, it } from "vitest";
import {
  DEMO_MACHINES,
  InstallState,
  isInstalledState,
  type Machine,
  type MachineComponent,
  machinesWithInstallCount,
  needsActionState,
  rollupFor,
} from "./mock";

const componentWith = (id: string, state: InstallState): MachineComponent => ({
  id,
  name: id,
  kind: "agent",
  harness: "claude",
  version: "2.4.0",
  state,
});

const machineWith = (
  online: boolean,
  states: readonly InstallState[]
): Machine => ({
  id: "m",
  name: "m",
  platform: "test",
  online,
  lastSeen: "just now",
  components: states.map((state, index) => componentWith(`c${index}`, state)),
});

describe("isInstalledState", () => {
  it("counts installed and updatable as having an install", () => {
    expect(isInstalledState(InstallState.Installed)).toBe(true);
    expect(isInstalledState(InstallState.Updatable)).toBe(true);
  });

  it("does not count not-installed as installed", () => {
    expect(isInstalledState(InstallState.NotInstalled)).toBe(false);
  });
});

describe("needsActionState", () => {
  it("flags not-installed and updatable as actionable", () => {
    expect(needsActionState(InstallState.NotInstalled)).toBe(true);
    expect(needsActionState(InstallState.Updatable)).toBe(true);
  });

  it("does not flag a current install as actionable", () => {
    expect(needsActionState(InstallState.Installed)).toBe(false);
  });
});

describe("rollupFor", () => {
  it("counts an updatable component as both installed and needing action", () => {
    const rollup = rollupFor(
      machineWith(true, [InstallState.Updatable, InstallState.Installed])
    );
    expect(rollup.installed).toBe(2);
    expect(rollup.needsAction).toBe(1);
    expect(rollup.total).toBe(2);
    expect(rollup.readable).toBe(true);
  });

  it("marks an offline machine unreadable while still counting last-known state", () => {
    const rollup = rollupFor(
      machineWith(false, [InstallState.Installed, InstallState.NotInstalled])
    );
    expect(rollup.readable).toBe(false);
    // Last-known counts survive: the offline machine is not zeroed out.
    expect(rollup.installed).toBe(1);
    expect(rollup.needsAction).toBe(1);
  });
});

describe("machinesWithInstallCount", () => {
  it("counts a machine with at least one install toward the numerator", () => {
    const machines = [
      machineWith(true, [InstallState.Installed]),
      machineWith(true, [InstallState.NotInstalled]),
    ];
    expect(machinesWithInstallCount(machines)).toEqual({
      installed: 1,
      total: 2,
    });
  });

  it("includes offline machines with a last-known install in the numerator and every machine in the denominator", () => {
    const machines = [
      machineWith(true, [InstallState.Installed]),
      machineWith(false, [InstallState.Installed]),
      machineWith(true, [InstallState.NotInstalled]),
    ];
    expect(machinesWithInstallCount(machines)).toEqual({
      installed: 2,
      total: 3,
    });
  });

  it("does not read as fully-installed for a partial machine over the demo data", () => {
    const result = machinesWithInstallCount(DEMO_MACHINES);
    // Every demo machine has at least one install (the partial and the offline
    // box included), so all three count — the helper is "has an install", not
    // "fully installed".
    expect(result.total).toBe(DEMO_MACHINES.length);
    expect(result.installed).toBe(DEMO_MACHINES.length);
  });
});

describe("DEMO_MACHINES", () => {
  it("keeps last-known per-component state on the offline machine rather than a wall of unknowns", () => {
    const offline = DEMO_MACHINES.find((machine) => !machine.online);
    expect(offline).toBeDefined();
    const states = new Set(offline?.components.map((c) => c.state));
    // The offline machine carries a mix of real states, not one repeated value.
    expect(states.size).toBeGreaterThan(1);
    expect(states.has(InstallState.Installed)).toBe(true);
  });
});
