/**
 * ISS-11262: the renderer isolation rules in scripts/dependency-cruiser.config.cjs,
 * driven through the shipped gate entrypoint so a rule that never fires cannot
 * pass as a clean tree. The production renderer has zero violations, so each
 * rule needs a positive control: a fixture built to break it, where the
 * forbidden module sits one hop behind an innocent `src/shared` import.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const CONFIG_PATH = path.join(
  desktopRoot,
  "scripts",
  "dependency-cruiser.config.cjs"
);
const GATE_ENTRYPOINT = path.join(
  desktopRoot,
  "scripts",
  "assert-design-system-boundary.mjs"
);
const BLOCKING_VIOLATIONS = /blocking dependency violations/;
const NO_VIOLATIONS_FOUND = /no dependency violations found/;

function writeRendererFixture(sharedModuleBody: string): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "renderer-boundary-gate-"));
  const write = (relativePath: string, contents: string): void => {
    const absolute = path.join(fixture, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  write(
    "tsconfig.json",
    '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"esnext"}}\n'
  );
  write("src/main/ipc/handler.ts", "export const handler = 1;\n");
  write(
    "src/renderer/view.ts",
    'import { value } from "../shared/helper.js";\nexport const view = value;\n'
  );
  write("src/shared/helper.ts", sharedModuleBody);
  return fixture;
}

function runGate(fixture: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      GATE_ENTRYPOINT,
      "--cwd",
      fixture,
      "--config",
      CONFIG_PATH,
      "--floor",
      "1",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runFixture(sharedModuleBody: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const fixture = writeRendererFixture(sharedModuleBody);
  try {
    return runGate(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const VIOLATIONS = [
  {
    scenario: "reaches src/main through a shared module",
    body: 'import { handler } from "../main/ipc/handler.js";\nexport const value = handler;\n',
    rule: "renderer-no-main-process",
  },
  {
    scenario: "reaches a node: builtin through a shared module",
    body: 'import { homedir } from "node:os";\nexport const value = homedir;\n',
    rule: "renderer-no-node-builtins",
  },
  {
    scenario: "reaches a bare builtin specifier through a shared module",
    body: 'import path from "path";\nexport const value = path.sep;\n',
    rule: "renderer-no-node-builtins",
  },
  {
    scenario: "reaches electron through a shared module",
    body: 'import { ipcRenderer } from "electron";\nexport const value = ipcRenderer;\n',
    rule: "renderer-no-electron",
  },
  {
    scenario: "reaches the realtime socket client through a shared module",
    body: 'import { createSocketIoRealtimeClient } from "@repo/realtime-client/connection";\nexport const value = createSocketIoRealtimeClient;\n',
    rule: "renderer-no-realtime-socket",
  },
] as const;

describe("renderer isolation rules", () => {
  it.each(VIOLATIONS)("rejects a renderer that $scenario", ({ body, rule }) => {
    const result = runFixture(body);
    assert.notEqual(
      result.status,
      0,
      `${rule} must fail the gate; it exited ${result.status}\n${result.stdout}`
    );
    assert.match(result.stderr, BLOCKING_VIOLATIONS);
    assert.match(result.stderr, new RegExp(rule));
  });

  it("passes a renderer whose shared imports are environment-neutral", () => {
    const result = runFixture("export const value = 1;\n");
    assert.equal(
      result.status,
      0,
      `a clean graph must pass; got ${result.status}\n${result.stderr}`
    );
    assert.match(result.stdout, NO_VIOLATIONS_FOUND);
  });
});
