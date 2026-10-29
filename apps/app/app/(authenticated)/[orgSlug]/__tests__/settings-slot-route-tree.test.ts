import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RETAINED_LEGACY_SETTINGS_PATHS } from "@/lib/settings-migration/settings-migration-matrix";

const ORG_SLUG_ROUTE = join(import.meta.dirname, "..");
const SLOT = join(ORG_SLUG_ROUTE, "@settings");
const INTERCEPT = join(SLOT, "(.)settings");
const LEGACY_SETTINGS = join(ORG_SLUG_ROUTE, "settings");
const SETTINGS_PREFIX = "/settings";

/** Every route file under a directory, as `/`-joined paths relative to it. */
function routeFiles(root: string, relative = ""): string[] {
  const here = join(root, relative);
  return readdirSync(here).flatMap((entry) => {
    const child = relative ? `${relative}/${entry}` : entry;
    if (statSync(join(root, child)).isDirectory()) {
      return routeFiles(root, child);
    }
    return entry === "page.tsx" || entry === "default.tsx" ? [child] : [];
  });
}

/**
 * ISS-8370 D2 — what the `@settings` slot can intercept, asserted against the
 * route TREE rather than by inspection. An intercepted device-authorize link
 * would break pairing for every installed Desktop build, so the slot must
 * define `/settings` and nothing beneath it.
 */
describe("the @settings parallel slot", () => {
  it("holds exactly the inert default, root page and catch-all, and the one intercept", () => {
    // The root page and the catch-all together deactivate the slot on EVERY
    // soft navigation away from the modal: the catch-all needs a segment, so
    // the org root would otherwise leave the modal open over its redirect.
    expect(routeFiles(SLOT).sort()).toEqual([
      "(.)settings/page.tsx",
      "[...unmatched]/page.tsx",
      "default.tsx",
      "page.tsx",
    ]);
  });

  it.each(RETAINED_LEGACY_SETTINGS_PATHS)(
    "leaves the retained legacy path %s to the real page tree",
    (retainedPath) => {
      const relative = retainedPath.slice(SETTINGS_PREFIX.length + 1);

      // The legacy page tree still owns it (a page somewhere under the prefix)...
      expect(existsSync(join(LEGACY_SETTINGS, relative))).toBe(true);
      expect(
        routeFiles(LEGACY_SETTINGS).some((file) =>
          file.startsWith(`${relative}/`)
        )
      ).toBe(true);
      // ...and the intercept defines no twin for it.
      expect(existsSync(join(INTERCEPT, relative))).toBe(false);
    }
  );
});
