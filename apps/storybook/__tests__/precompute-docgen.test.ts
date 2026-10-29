// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DocgenScope,
  precomputeDocgen,
} from "../.storybook/precompute-docgen";

type Transform = (this: unknown, code: string, id: string) => unknown;
type Hook = (this: unknown) => unknown;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "precompute-docgen-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("precomputeDocgen", () => {
  it("runs docgen for every root in buildStart, then tears the program down", async () => {
    write("packages/design-system/button.tsx", "export const Button = 1;\n");
    write("apps/storybook/fixture.tsx", "export const Fixture = 1;\n");
    write("apps/storybook/demo.stories.tsx", "export default {};\n");
    const order: string[] = [];
    const { docgen, original, teardown } = fakeDocgen((code, id) => {
      order.push(id);
      return withBlock(code, `${id}.__docgenInfo`);
    });
    const releaseHeap = vi.fn(() => {
      order.push("release");
    });
    const plugin = await started(
      precomputeDocgen(docgen, scope(), releaseHeap)
    );

    expect(order).toEqual([
      file("packages/design-system/button.tsx"),
      file("apps/storybook/fixture.tsx"),
      "release",
    ]);
    expect(original).toHaveBeenCalledWith(
      "export const Button = 1;\n",
      file("packages/design-system/button.tsx")
    );
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown.mock.invocationCallOrder[0]).toBeLessThan(
      releaseHeap.mock.invocationCallOrder[0]
    );
    expect(plugin.name).toBe("closedloop:precompute-docgen");
  });

  it("replays each stored block onto the source the real transform receives", async () => {
    write("packages/design-system/button.tsx", "disk source\n");
    const { docgen, original } = fakeDocgen((code) =>
      withBlock(code, "Button.__docgenInfo = {}")
    );
    await started(precomputeDocgen(docgen, scope(), vi.fn()));
    original.mockClear();

    const id = `${file("packages/design-system/button.tsx")}?v=1`;
    expect(transform(docgen)("compiled", id)).toEqual({
      code: "compiled\nButton.__docgenInfo = {}",
      map: null,
    });
    expect(transform(docgen)("compiled\n", id)).toEqual({
      code: "compiled\nButton.__docgenInfo = {}",
      map: null,
    });
    expect(original).not.toHaveBeenCalled();
  });

  it("answers as the plugin does for roots without docs and for files outside the program", async () => {
    write("packages/app/no-docs.tsx", "export const value = 1;\n");
    write("packages/app/failed.tsx", "export const broken = 1;\n");
    const { docgen, original } = fakeDocgen((code, id) =>
      id.endsWith("failed.tsx") ? code : null
    );
    await started(precomputeDocgen(docgen, scope(), vi.fn()));
    original.mockClear();

    expect(transform(docgen)("x", file("packages/app/no-docs.tsx"))).toBeNull();
    expect(transform(docgen)("x", file("packages/app/failed.tsx"))).toBe("x");
    // Matched by the filter but not a program root (written after buildStart).
    expect(transform(docgen)("x", file("apps/app/page.tsx"))).toBe("x");
    expect(
      transform(docgen)("x", file("apps/storybook/demo.stories.tsx"))
    ).toBeUndefined();
    expect(
      transform(docgen)("x", file("packages/app/util.js"))
    ).toBeUndefined();
    expect(original).not.toHaveBeenCalled();
  });

  it("warns once per file outside the program, as the plugin does", async () => {
    const { docgen } = fakeDocgen(() => null);
    await started(precomputeDocgen(docgen, scope(), vi.fn()));
    const context = pluginContext();
    const run = docgen.transform as Transform;
    run.call(context, "x", file("apps/app/page.tsx"));
    run.call(context, "x", `${file("apps/app/page.tsx")}?v=2`);
    expect(context.warn).toHaveBeenCalledTimes(1);
    expect(context.warn).toHaveBeenCalledWith(
      `Skipping docgen for "${file("apps/app/page.tsx")}" because it is not included in the active TypeScript project.`
    );
  });

  it("forwards to the plugin until buildStart has run", () => {
    const { docgen, original } = fakeDocgen(() => "plugin output");
    precomputeDocgen(docgen, scope(), vi.fn());
    expect(transform(docgen)("x", file("packages/app/a.tsx"))).toBe(
      "plugin output"
    );
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("fails the build when the plugin output is not the source plus a block", async () => {
    write("packages/app/a.tsx", "source\n");
    const { docgen } = fakeDocgen(() => ({ code: "rewritten", map: null }));
    const plugin = precomputeDocgen(docgen, scope(), vi.fn());
    (plugin.configResolved as (c: { root: string }) => void)({ root });
    await expect(
      (plugin.buildStart as Hook).call(pluginContext())
    ).rejects.toThrow("cannot replay it");
  });

  it("fails when the plugin no longer has a plain transform function", () => {
    const docgen: Plugin = {
      name: "vite:react-docgen-typescript",
      transform: { handler: vi.fn() },
    };
    expect(() => precomputeDocgen(docgen, scope(), vi.fn())).toThrow(
      "no longer exposes a plain transform function"
    );
  });
});

function fakeDocgen(output: (code: string, id: string) => unknown) {
  const original = vi.fn(function plugin(
    this: unknown,
    code: string,
    id: string
  ) {
    return output(code, id);
  });
  const teardown = vi.fn();
  const docgen = {
    name: "vite:react-docgen-typescript",
    transform: original,
    buildEnd: teardown,
  } as Plugin;
  return { docgen, original, teardown };
}

async function started(plugin: Plugin): Promise<Plugin> {
  (plugin.configResolved as (c: { root: string }) => void)({ root });
  await (plugin.buildStart as Hook).call(pluginContext());
  return plugin;
}

function transform(docgen: Plugin): (code: string, id: string) => unknown {
  return (code, id) =>
    (docgen.transform as Transform).call(pluginContext(), code, id);
}

function pluginContext(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

function withBlock(code: string, block: string) {
  return {
    code: `${code}${code.endsWith("\n") ? "" : "\n"}${block}`,
    map: null,
  };
}

function scope(): DocgenScope {
  return {
    include: [`${root}/**/*.tsx`],
    exclude: [`${root}/**/*.stories.tsx`],
  };
}

function write(relative: string, contents: string): void {
  mkdirSync(dirname(file(relative)), { recursive: true });
  writeFileSync(file(relative), contents);
}

function file(relative: string): string {
  return join(root, relative);
}
