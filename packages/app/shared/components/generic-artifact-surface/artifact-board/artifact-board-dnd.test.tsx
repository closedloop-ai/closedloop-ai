import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useArtifactBoardPointerSensors,
  useArtifactBoardSensors,
} from "./artifact-board-dnd";

const mocks = vi.hoisted(() => ({
  sensors: vi.fn((...sensors: unknown[]) => sensors),
}));

vi.mock("@dnd-kit/core", () => ({
  KeyboardSensor: "keyboard",
  MouseSensor: "mouse",
  TouchSensor: "touch",
  useSensor: (sensor: unknown, options?: unknown) => ({ options, sensor }),
  useSensors: (...sensors: unknown[]) => mocks.sensors(...sensors),
}));

describe("CT-15 Artifact Board input mechanics", () => {
  beforeEach(() => {
    mocks.sensors.mockClear();
  });

  it("shares mouse and touch activation while making keyboard opt-in explicit", () => {
    const champion = renderHook(() => useArtifactBoardSensors());
    expect(champion.result.current).toEqual([
      { options: undefined, sensor: "keyboard" },
      { options: { activationConstraint: { distance: 8 } }, sensor: "mouse" },
      {
        options: { activationConstraint: { delay: 250, tolerance: 5 } },
        sensor: "touch",
      },
    ]);
    champion.unmount();

    const pointerOnly = renderHook(() => useArtifactBoardPointerSensors());
    expect(pointerOnly.result.current).toEqual([
      { options: { activationConstraint: { distance: 8 } }, sensor: "mouse" },
      {
        options: { activationConstraint: { delay: 250, tolerance: 5 } },
        sensor: "touch",
      },
    ]);
  });
});
