import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript6";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/datadog-rum/client", () => ({
  initDatadogRum: vi.fn(),
}));

vi.mock("@datadog/browser-rum-nextjs", () => ({
  onRouterTransitionStart: vi.fn(),
}));

describe("instrumentation-client zod jitless wiring (FEA-4149)", () => {
  afterAll(() => {
    z.config({ jitless: undefined });
  });

  it("sets zod's jitless flag so client schemas never JIT-compile with Function() under the strict CSP", async () => {
    expect(z.config().jitless).toBeUndefined();

    await import("../instrumentation-client");

    expect(z.config().jitless).toBe(true);

    const { initDatadogRum } = await import("@/lib/datadog-rum/client");
    expect(initDatadogRum).toHaveBeenCalledTimes(1);
  });

  // The jitless config only beats sibling imports (which construct zod schemas
  // during their own module evaluation, before any statement in this module
  // runs) by being the FIRST import declaration. That ordering cannot be
  // expressed in the type system, so it is pinned structurally here: the guard
  // fails when any import is added above it or an organize-imports pass moves
  // it.
  it("keeps the zod-jitless side-effect import as the first import declaration", () => {
    const sourcePath = join(
      import.meta.dirname,
      "..",
      "instrumentation-client.ts"
    );
    const source = ts.createSourceFile(
      "instrumentation-client.ts",
      readFileSync(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );

    const imports = source.statements.filter(ts.isImportDeclaration);
    const firstSpecifier = imports.at(0)?.moduleSpecifier;

    expect(
      firstSpecifier !== undefined &&
        ts.isStringLiteral(firstSpecifier) &&
        firstSpecifier.text
    ).toBe("@/lib/zod-jitless");
  });

  // ISS-12135: `z.config` writes the config of the zod copy it is called on,
  // so a workspace package resolving another copy builds its schemas with the
  // JIT on, and that copy's `Function("")` capability probe is a CSP violation
  // on every page that imports it. `@repo/realtime-client` resolved zod 4.6.5
  // while this app ran 4.3.6, and #8456 put it in the client bundle. The
  // `zod` catalog entry in pnpm-workspace.yaml pins the version; this is the
  // backstop for a package that does not use it.
  it("resolves one zod copy across every workspace package the app bundles", () => {
    const appDir = join(import.meta.dirname, "..");
    const appZod = resolvedZodDir(appDir);
    expect(appZod).toBeDefined();

    const visited = new Set<string>();
    const pending = [appDir];
    const strays: string[] = [];
    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      const manifest = readPackageManifest(dir);
      // Read the link whatever section declares zod: a peer satisfied by a
      // dev copy (`@closedloop-ai/loops-api`) bundles that dev copy.
      const zod = resolvedZodDir(dir);
      if (zod !== undefined && zod !== appZod) {
        strays.push(`${manifest.name} -> ${zod}`);
      }
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        if (!range.startsWith(WORKSPACE_RANGE_PREFIX)) {
          continue;
        }
        const workspaceDir = realpathSync(join(dir, "node_modules", name));
        if (!visited.has(workspaceDir)) {
          visited.add(workspaceDir);
          pending.push(workspaceDir);
        }
      }
    }

    expect(visited.size).toBeGreaterThan(0);
    expect(strays).toEqual([]);
  });
});

const WORKSPACE_RANGE_PREFIX = "workspace:";

const packageManifestSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

function readPackageManifest(dir: string) {
  return packageManifestSchema.parse(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  );
}

function resolvedZodDir(dir: string): string | undefined {
  const link = join(dir, "node_modules", "zod");
  return existsSync(link) ? realpathSync(link) : undefined;
}
