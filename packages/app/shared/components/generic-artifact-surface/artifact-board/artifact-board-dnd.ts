"use client";

import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

/** Shared pointer/touch activation profile for artifact board consumers. */
export function useArtifactBoardSensors() {
  const [mouse, touch] = useArtifactBoardPointerSensorInstances();
  const keyboard = useSensor(KeyboardSensor);
  return useSensors(keyboard, mouse, touch);
}

/** Pointer-only profile for hosts whose cards retain link keyboard semantics. */
export function useArtifactBoardPointerSensors() {
  const [mouse, touch] = useArtifactBoardPointerSensorInstances();
  return useSensors(mouse, touch);
}

function useArtifactBoardPointerSensorInstances() {
  const mouse = useSensor(MouseSensor, {
    activationConstraint: { distance: 8 },
  });
  const touch = useSensor(TouchSensor, {
    activationConstraint: { delay: 250, tolerance: 5 },
  });
  return [mouse, touch] as const;
}
