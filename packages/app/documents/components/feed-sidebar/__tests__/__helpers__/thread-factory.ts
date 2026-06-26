import type { ThreadData } from "@liveblocks/client";

const DEFAULT_CREATED_AT = new Date("2026-05-18T14:00:00Z");

/**
 * Shared test factory for Liveblocks `ThreadData`. Returns a valid
 * default fixture; callers spread any subset of `ThreadData` fields to
 * override. Keeping the input typed as `Partial<ThreadData>` means
 * callers stay type-safe — passing an ill-typed `metadata` or `comments`
 * value fails at the call site instead of silently coercing through a
 * cast.
 */
export function makeThread(overrides: Partial<ThreadData> = {}): ThreadData {
  return {
    type: "thread",
    id: "thread-default",
    roomId: "room_1",
    createdAt: DEFAULT_CREATED_AT,
    updatedAt: DEFAULT_CREATED_AT,
    metadata: {},
    comments: [],
    resolved: false,
    ...overrides,
  };
}
