/**
 * ISS-12426 item 4: the catalog gate must fail on an allowlist entry that no
 * prototype imports, because the gardener treats every listed module as in
 * use. This drives the real gate script in a throwaway tree whose only
 * prototype imports one allowlisted module, so every other entry is stale;
 * deleting the gate's stale-entry check leaves the run green and fails here.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptsDir = import.meta.dirname;
const IMPORTED = "@repo/app/shell/v2/components/prototype-shell";
const NOT_IMPORTED = "@repo/app/search/components/search-surface-v2-page-demo";

let root;
afterEach(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

function write(file, text) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe("check-catalog-imports stale allowlist entries (ISS-12426)", () => {
  it("fails and names entries no prototype imports", () => {
    root = mkdtempSync(join(tmpdir(), "catalog-gate-"));
    for (const file of [
      "check-catalog-imports.mjs",
      "catalog-allowlist-staleness.mjs",
    ]) {
      const target = join(root, "apps/prototypes/scripts", file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(scriptsDir, file), target);
    }
    write(
      "packages/design-system/storybook/component-catalog.mjs",
      "export const designSystemComponentCatalog = [];\n"
    );
    write(
      "packages/design-system/storybook/component-catalog.ts",
      'export { designSystemComponentCatalog } from "./component-catalog.mjs";\n'
    );
    write(
      "apps/prototypes/app/p/example/page.tsx",
      `import { PrototypeShell } from "${IMPORTED}";\nexport default PrototypeShell;\n`
    );
    mkdirSync(join(root, "apps/prototypes/lib"), { recursive: true });

    const child = spawnSync(
      process.execPath,
      [join(root, "apps/prototypes/scripts/check-catalog-imports.mjs")],
      { encoding: "utf8", timeout: 30_000 }
    );
    if (child.error) {
      throw child.error;
    }

    expect(child.status).toBe(1);
    expect(child.stderr).toContain(
      `"${NOT_IMPORTED}" is in portableSurfaceAllowlist but no prototype imports it`
    );
    expect(child.stderr).not.toContain(
      `"${IMPORTED}" is in portableSurfaceAllowlist`
    );
  });
});
