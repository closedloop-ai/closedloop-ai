import { describe, expect, it } from "vitest";
import {
  DeploymentEventState,
  isDeploymentFailureState,
  isDeploymentSuccessState,
  isDeploymentTerminalState,
  normalizeDeploymentEventState,
} from "./deployment-event";

describe("normalizeDeploymentEventState", () => {
  it.each([
    ["queued", DeploymentEventState.Queued],
    ["pending", DeploymentEventState.Pending],
    ["waiting", DeploymentEventState.Pending],
    ["in_progress", DeploymentEventState.InProgress],
    ["success", DeploymentEventState.Success],
    ["failure", DeploymentEventState.Failure],
    ["error", DeploymentEventState.Error],
    ["inactive", DeploymentEventState.Inactive],
  ])("maps the GitHub vocabulary value %s", (providerState, expected) => {
    expect(normalizeDeploymentEventState(providerState)).toBe(expected);
  });

  it.each([
    ["  SUCCESS  "],
    ["Failure"],
  ])("is case- and whitespace-insensitive for %s", (providerState) => {
    expect(normalizeDeploymentEventState(providerState)).not.toBe(
      DeploymentEventState.Unknown
    );
  });

  it.each([
    ["quantum_rollout"],
    [""],
    ["__proto__"],
    ["constructor"],
    ["toString"],
  ])("degrades the unrecognized value %s to UNKNOWN", (providerState) => {
    expect(normalizeDeploymentEventState(providerState)).toBe(
      DeploymentEventState.Unknown
    );
  });

  it.each([
    [null],
    [undefined],
  ])("degrades the absent value %s to UNKNOWN", (providerState) => {
    expect(normalizeDeploymentEventState(providerState)).toBe(
      DeploymentEventState.Unknown
    );
  });
});

describe("DORA state classification", () => {
  it("counts only SUCCESS as a healthy completed deployment", () => {
    expect(isDeploymentSuccessState(DeploymentEventState.Success)).toBe(true);
    for (const state of [
      DeploymentEventState.Failure,
      DeploymentEventState.Error,
      DeploymentEventState.Inactive,
      DeploymentEventState.InProgress,
      DeploymentEventState.Unknown,
    ]) {
      expect(isDeploymentSuccessState(state)).toBe(false);
    }
  });

  it.each([
    [DeploymentEventState.Failure],
    [DeploymentEventState.Error],
  ])("counts %s toward change-failure rate", (state) => {
    expect(isDeploymentFailureState(state)).toBe(true);
  });

  it("excludes INACTIVE from the failure set", () => {
    // GitHub marks superseded deployments inactive during a NORMAL successful
    // rollout, so counting it would inflate change-failure rate on every deploy.
    expect(isDeploymentFailureState(DeploymentEventState.Inactive)).toBe(false);
    expect(isDeploymentTerminalState(DeploymentEventState.Inactive)).toBe(
      false
    );
  });

  it("treats UNKNOWN as non-terminal so it makes no completion claim", () => {
    expect(isDeploymentTerminalState(DeploymentEventState.Unknown)).toBe(false);
    expect(isDeploymentSuccessState(DeploymentEventState.Unknown)).toBe(false);
    expect(isDeploymentFailureState(DeploymentEventState.Unknown)).toBe(false);
  });

  it.each([
    [DeploymentEventState.Success],
    [DeploymentEventState.Failure],
    [DeploymentEventState.Error],
  ])("treats %s as ending a deployment attempt", (state) => {
    expect(isDeploymentTerminalState(state)).toBe(true);
  });

  it.each([
    [DeploymentEventState.Queued],
    [DeploymentEventState.Pending],
    [DeploymentEventState.InProgress],
  ])("treats the in-flight state %s as non-terminal", (state) => {
    expect(isDeploymentTerminalState(state)).toBe(false);
  });
});
