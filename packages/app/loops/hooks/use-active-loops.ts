"use client";

import type { LoopWithUser } from "@repo/api/src/types/loop";
import { useMemo } from "react";
import { ACTIVE_LOOP_STATUSES } from "../lib/loop-constants";

/** Active loop rows for list/table UIs (memoized). */
export function useActiveLoops(loops: LoopWithUser[]): LoopWithUser[] {
  return useMemo(
    () => loops.filter((l) => ACTIVE_LOOP_STATUSES.has(l.status)),
    [loops]
  );
}
