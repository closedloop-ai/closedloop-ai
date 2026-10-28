import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const desktop = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const ownerApi: {
  desktopFromMainArgs(argv: string[]): string;
  createOwnerQualifier(
    root: string
  ): (callback: () => Promise<void>, delay: number, stack: string) => unknown;
} = desktopRequire("./test/e2e/helpers/telemetry-interval-owner.cjs");
const temporaryDirectories: string[] = [];
const returnedArrow: () => Promise<void> =
  vm.runInNewContext("() => this.kick()");
const discardedArrow: () => Promise<void> = vm.runInNewContext(
  "() => { this.kick(); }"
);
const originalModule = `const SYNC_INTERVAL_MS = 15000;
class ClaudeCodeTelemetrySyncService {
  start() {
    const interval = this.options.intervalMs ?? SYNC_INTERVAL_MS;
    this.timer = setInterval(() => this.kick(), interval);
    this.timer.unref?.();
  }
  kick() {
    if (this.tick) { return this.tick; }
    this.tick = this.syncOnce().finally(() => { this.tick = null; });
    return this.tick;
  }
  async syncOnce() {}
}`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable telemetry interval owner admission", () => {
  it("derives the owning package from one actual MAIN entry", () => {
    const fixture = builtFixture(originalModule);
    expect(ownerApi.desktopFromMainArgs(["electron", fixture.entry])).toBe(
      fixture.root
    );
    expect(() => ownerApi.desktopFromMainArgs([])).toThrow("one canonical");
    expect(() =>
      ownerApi.desktopFromMainArgs([fixture.entry, fixture.entry])
    ).toThrow("one canonical");
  });

  it.each([
    originalModule,
    originalModule.replace(
      "if (this.tick) { return this.tick; }",
      "if (this.tick) return this.tick;"
    ),
    originalModule.replace(
      "class ClaudeCodeTelemetrySyncService {",
      "const ClaudeCodeTelemetrySyncService = class {"
    ),
  ])(
    "qualifies the current built class and dynamic runtime call site",
    (source) => {
      const fixture = builtFixture(source);
      const qualify = ownerApi.createOwnerQualifier(fixture.root);
      expect(qualify(returnedArrow, 15_000, fixture.stack)).toMatchObject({
        sourceQualified: true,
        canonicalCadence: 15_000,
        ownerClass: "ClaudeCodeTelemetrySyncService",
        ownerMethod: "start",
        moduleRelative: "startup-fixture.js",
        noPrecomputedLocationOrHash: true,
      });
    }
  );

  it("leaves foreign intervals of the identical delay native", () => {
    const fixture = builtFixture(originalModule);
    const qualify = ownerApi.createOwnerQualifier(fixture.root);
    expect(
      qualify(
        returnedArrow,
        15_000,
        "Error\n    at ForeignService.start (foreign.js:1:1)"
      )
    ).toBeNull();
  });

  it.each([
    [
      "discarded completion",
      originalModule.replace("() => this.kick()", "() => { this.kick(); }"),
    ],
    [
      "lost shared promise",
      originalModule.replace(
        "if (this.tick) { return this.tick; }",
        "if (this.tick) { return; }"
      ),
    ],
    [
      "lost final reset",
      originalModule.replace("this.tick = null", "this.tick = undefined"),
    ],
    ["changed cadence", originalModule.replace("15000", "15001")],
    [
      "different handle owner",
      originalModule.replace(
        "this.timer = setInterval",
        "this.otherTimer = setInterval"
      ),
    ],
    [
      "duplicate owner",
      `${originalModule}\nclass ClaudeCodeTelemetrySyncService {}`,
    ],
  ])("refuses %s in the newly built owner", (_name, source) => {
    const fixture = builtFixture(source);
    expect(() =>
      ownerApi.createOwnerQualifier(fixture.root)(
        returnedArrow,
        15_000,
        fixture.stack
      )
    ).toThrow();
  });

  it("refuses a runtime callback that discards the source-qualified return", () => {
    const fixture = builtFixture(originalModule);
    expect(() =>
      ownerApi.createOwnerQualifier(fixture.root)(
        discardedArrow,
        15_000,
        fixture.stack
      )
    ).toThrow("Runtime callback");
  });

  it("refuses a recognized owner outside the current built MAIN directory", () => {
    const fixture = builtFixture(originalModule);
    const outside = path.join(fixture.root, "outside.js");
    writeFileSync(outside, originalModule);
    const stack = fixture.stack.replace(
      pathToFileURL(fixture.module).href,
      pathToFileURL(outside).href
    );
    expect(() =>
      ownerApi.createOwnerQualifier(fixture.root)(returnedArrow, 15_000, stack)
    ).toThrow("outside");
  });

  it("refuses ambiguous owner frames and changed runtime cadence", () => {
    const fixture = builtFixture(originalModule);
    const qualify = ownerApi.createOwnerQualifier(fixture.root);
    expect(() =>
      qualify(returnedArrow, 15_000, `${fixture.stack}\n${fixture.stack}`)
    ).toThrow("Ambiguous");
    expect(() => qualify(returnedArrow, 15_001, fixture.stack)).toThrow(
      "cadence"
    );
  });
});

/** Synthetic artifacts exercise the executed AST decision without scanning production source. */
function builtFixture(source: string) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "telemetry-owner-"))
  );
  temporaryDirectories.push(root);
  const main = path.join(root, "dist/main");
  mkdirSync(main, { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    '{"name":"synthetic-desktop"}'
  );
  symlinkSync(
    path.join(desktop, "node_modules"),
    path.join(root, "node_modules"),
    "dir"
  );
  const entry = path.join(main, "index.js");
  const module = path.join(main, "startup-fixture.js");
  writeFileSync(entry, "");
  writeFileSync(module, source);
  const offset = source.indexOf("setInterval(");
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length;
  const column = offset - prefix.lastIndexOf("\n");
  return {
    root,
    entry,
    module,
    stack: `Error\n    at ClaudeCodeTelemetrySyncService.start (${pathToFileURL(module).href}:${line}:${column})`,
  };
}
