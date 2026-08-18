"use client";

import { clamp } from "@repo/api/src/utils/math";
import { useCallback, useState } from "react";
import type { FeedArtifactType } from "./types";

const DEFAULT_WIDTH = 350;
const MIN_WIDTH = 350;
const MAX_WIDTH = 720;

function storageKey(
  organizationId: string,
  artifactType: FeedArtifactType
): string {
  return `feed-rail-width:${organizationId}:${artifactType}`;
}

/** Pin a candidate width to the persisted rail's fixed `[MIN, MAX]` range. */
function clampWidth(value: number): number {
  return clamp(value, MIN_WIDTH, MAX_WIDTH);
}

function readWidth(key: string): number {
  if (globalThis.window === undefined) {
    return DEFAULT_WIDTH;
  }
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (!raw) {
      return DEFAULT_WIDTH;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_WIDTH;
    }
    return clampWidth(parsed);
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeWidth(key: string, value: number): void {
  if (globalThis.window === undefined) {
    return;
  }
  try {
    globalThis.localStorage.setItem(key, String(value));
  } catch {
    // Ignore quota errors etc. — width is best-effort UX.
  }
}

/**
 * React hook for the persisted Feed sidebar width. Width is per-org and
 * per-artifact-type, persisted to localStorage. Clamped to [MIN, MAX].
 */
export function useFeedRailWidth(
  organizationId: string,
  artifactType: FeedArtifactType
): [number, (next: number) => void] {
  const key = storageKey(organizationId, artifactType);
  const [width, setWidth] = useState<number>(() => readWidth(key));

  const setWidthWrapper = useCallback(
    (next: number) => {
      const clamped = clampWidth(next);
      setWidth(clamped);
      writeWidth(key, clamped);
    },
    [key]
  );

  return [width, setWidthWrapper];
}
