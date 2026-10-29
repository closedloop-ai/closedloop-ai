import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const TSX = resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");

const SCRIPTS = [
  {
    name: "backfill-search-documents",
    path: resolve(import.meta.dirname, "backfill-search-documents.ts"),
    errorTag: "[backfill-search-documents]",
  },
  {
    name: "backfill-definition-versions",
    path: resolve(import.meta.dirname, "backfill-definition-versions.ts"),
    errorTag: "[backfill-definition-versions]",
  },
  {
    name: "backfill-pack-definition-versions",
    path: resolve(import.meta.dirname, "backfill-pack-definition-versions.ts"),
    errorTag: "[backfill-pack-definition-versions]",
  },
] as const;

const UNROUTABLE_DB =
  "postgresql://localhost:19999/nonexistent?connect_timeout=2";

const ENV = {
  ...process.env,
  DATABASE_URL: UNROUTABLE_DB,
  NODE_NO_WARNINGS: "1",
};

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "guard test "));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// The react-server condition resolves `import "server-only"` to its empty
// export, so the two scripts that carry it reach the guard instead of throwing
// at import time. The script's own error tag then proves main() ran.
function run(scriptPath: string) {
  return spawnSync(TSX, ["--conditions=react-server", scriptPath], {
    encoding: "utf-8",
    timeout: 15_000,
    env: ENV,
  });
}

describe("direct-run guard runs main() from a spaced symlink path", () => {
  for (const script of SCRIPTS) {
    test(script.name, () => {
      const link = join(tempDir, `${script.name}.ts`);
      symlinkSync(script.path, link);

      const result = run(link);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(script.errorTag);
    });
  }
});

describe("direct-run guard runs main() from the real path", () => {
  for (const script of SCRIPTS) {
    test(script.name, () => {
      const result = run(script.path);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(script.errorTag);
    });
  }
});
