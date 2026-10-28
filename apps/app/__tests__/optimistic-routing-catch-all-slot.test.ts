// @vitest-environment node
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

/**
 * ISS-10949: a catch-all inside a parallel slot takes the URL path as its
 * param, and Next's optimistic routing copies that param from the known route
 * it predicts from, so every predicted route requests the wrong slot segment.
 * Next 16.3.1+ answers the mismatch by invalidating the whole route cache,
 * which re-prefetches every visible link. While any parallel slot carries a
 * catch-all, the resolved `next.config.ts` has to keep optimistic routing off.
 * ISS-11392 removes the one in the Settings slot; once no slot catch-all is
 * left, this file goes with it.
 */

const ROUTES_ROOT = join(import.meta.dirname, "..", "app");
const CATCH_ALL_SEGMENT = /^\[\[?\.\.\.[^\]]+\]\]?$/;

function findSlotCatchAlls(dir: string, insideSlot: boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(dir, entry.name);
    const inSlot = insideSlot || entry.name.startsWith("@");
    if (inSlot && CATCH_ALL_SEGMENT.test(entry.name)) {
      found.push(relative(ROUTES_ROOT, path));
    }
    found.push(...findSlotCatchAlls(path, inSlot));
  }
  return found;
}

describe("optimistic routing stays off while a parallel slot has a catch-all", () => {
  it("resolves optimisticRouting to false while any slot catch-all exists", () => {
    // A renamed or moved slot catch-all is still found here; only removing
    // every one of them empties the scan.
    const slotCatchAlls = findSlotCatchAlls(ROUTES_ROOT, false);
    expect(
      slotCatchAlls,
      "No parallel slot under apps/app/app has a catch-all segment, so this guard's premise is gone (ISS-11392): remove experimental.optimisticRouting from apps/app/next.config.ts and delete this test file."
    ).not.toHaveLength(0);
    // An absent key is Next's default, which is ON.
    expect(
      nextConfig.experimental?.optimisticRouting,
      `Slot catch-all(s) still present (${slotCatchAlls.join(", ")}): experimental.optimisticRouting must stay false in apps/app/next.config.ts (ISS-10949).`
    ).toBe(false);
  });
});
