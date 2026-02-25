"use client";

import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ReactNode } from "react";

/**
 * Custom collision detection that prioritises pointer-within checks (so wide
 * draggable rows can reach narrow sidebar droppables) and falls back to
 * closestCenter for within-table reordering where the pointer may land in
 * the gap between rows.
 */
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }
  return closestCenter(args);
};

type DndProviderProps = {
  children: ReactNode;
  onDragEnd?: (event: DragEndEvent) => void;
};

export function DndProvider({
  children,
  onDragEnd,
}: Readonly<DndProviderProps>) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor)
  );

  return (
    <DndContext
      collisionDetection={collisionDetection}
      onDragEnd={onDragEnd}
      sensors={sensors}
    >
      {children}
    </DndContext>
  );
}
