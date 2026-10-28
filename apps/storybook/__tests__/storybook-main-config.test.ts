// @vitest-environment node
// `main.ts` calls `fileURLToPath(new URL(..., import.meta.url))` at module
// scope; under jsdom that URL is not `file:`, so this suite runs under node.
import { fileURLToPath } from "node:url";
import { createFilter, type Plugin, type UserConfig } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import config from "../.storybook/main";
import { docgenPluginGlob } from "../.storybook/precompute-docgen";

const { gc, runInNewContext, setFlagsFromString, calls } = vi.hoisted(() => {
  const callLog: string[] = [];
  const gcMock = vi.fn();
  return {
    calls: callLog,
    gc: gcMock,
    runInNewContext: vi.fn((code: string): unknown => {
      callLog.push(code);
      return gcMock;
    }),
    setFlagsFromString: vi.fn((flag: string) => {
      callLog.push(flag);
    }),
  };
});
vi.mock("node:vm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:vm")>()),
  runInNewContext,
}));
vi.mock("node:v8", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:v8")>()),
  setFlagsFromString,
}));

const DOCGEN_PLUGIN_NAME = "storybook:react-docgen-plugin";
const RELEASE_HEAP_PLUGIN_NAME = "closedloop:release-docgen-heap";
const PRECOMPUTE_PLUGIN_NAME = "closedloop:precompute-docgen";
const DOCGEN_TS_PLUGIN_NAME = "vite:react-docgen-typescript";
const DESIGN_SYSTEM_SOURCE = /packages\/design-system$/;
const POSTHOG_MOCK = /apps\/app\/vitest-mocks\/posthog-next\.tsx$/;

type PropFilter = (prop: { parent?: { fileName: string } }) => boolean;
type Transform = (code: string, id: string) => unknown;

function propFilter(): PropFilter {
  const options = config.typescript?.reactDocgenTypescriptOptions as {
    propFilter: PropFilter;
  };
  return options.propFilter;
}

async function runViteFinal(
  viteConfig: UserConfig,
  configType?: "DEVELOPMENT" | "PRODUCTION"
): Promise<UserConfig> {
  const viteFinal = config.viteFinal as (
    c: UserConfig,
    o: unknown
  ) => UserConfig | Promise<UserConfig>;
  return await viteFinal(viteConfig, { configType });
}

function docgenPlugin(transform: Transform): Plugin {
  return { name: DOCGEN_PLUGIN_NAME, transform } as Plugin;
}

function docgenTsPlugin(transform: Transform): Plugin {
  return { name: DOCGEN_TS_PLUGIN_NAME, transform } as Plugin;
}

function pluginNames(viteConfig: UserConfig): string[] {
  return (viteConfig.plugins ?? [])
    .flat()
    .map((plugin) => (plugin as Plugin).name);
}

describe("storybook main.ts propFilter", () => {
  it("drops props declared under node_modules", () => {
    expect(
      propFilter()({
        parent: { fileName: "/x/node_modules/@types/react/index.d.ts" },
      })
    ).toBe(false);
  });

  it("keeps props declared in workspace source", () => {
    expect(
      propFilter()({
        parent: { fileName: "/x/packages/design-system/button.tsx" },
      })
    ).toBe(true);
  });

  it("keeps props with no parent declaration", () => {
    expect(propFilter()({})).toBe(true);
  });
});

describe("storybook main.ts viteFinal", () => {
  it("creates resolve when absent and aliases design-system to source", async () => {
    const result = await runViteFinal({
      plugins: [docgenPlugin(vi.fn())],
    });
    const alias = result.resolve?.alias as Record<string, string>;
    expect(alias["@repo/design-system"]).toMatch(DESIGN_SYSTEM_SOURCE);
    expect(alias["@repo/design-system"]).toMatch(DESIGN_SYSTEM_SOURCE);
    expect(alias["@posthog/next"]).toMatch(POSTHOG_MOCK);
  });

  it("keeps an existing resolve object and merges framework aliases", async () => {
    const resolve = { alias: { "next/image": "/framework/next-image" } };
    const result = await runViteFinal({
      resolve,
      plugins: [docgenPlugin(vi.fn())],
    });
    expect(result.resolve).toBe(resolve);
    const alias = result.resolve?.alias as Record<string, string>;
    expect(alias["next/image"]).toBe("/framework/next-image");
    expect(alias["@repo/design-system"]).toMatch(DESIGN_SYSTEM_SOURCE);
  });

  it("forwards TypeScript sources to the original docgen transform", async () => {
    const original = vi.fn(() => "docgen-output");
    const plugin = docgenPlugin(original);
    await runViteFinal({ plugins: [plugin] });
    const patched = plugin.transform as Transform;
    expect(patched("code", "/src/button.tsx?v=1")).toBe("docgen-output");
    expect(patched("code", "/src/util.ts")).toBe("docgen-output");
    expect(original).toHaveBeenCalledTimes(2);
    expect(original).toHaveBeenCalledWith("code", "/src/button.tsx?v=1");
  });

  it("skips JavaScript sources without calling the original transform", async () => {
    const original = vi.fn(() => "docgen-output");
    const plugin = docgenPlugin(original);
    await runViteFinal({ plugins: [plugin] });
    const patched = plugin.transform as Transform;
    expect(patched("code", "/node_modules/lib/index.js")).toBeNull();
    expect(patched("code", "/src/button.tsx.js?x=.tsx")).toBeNull();
    expect(original).not.toHaveBeenCalled();
  });

  it("leaves unrelated plugins untouched and patches nested docgen plugins", async () => {
    const otherTransform = vi.fn();
    const other = { name: "other-plugin", transform: otherTransform } as Plugin;
    const original = vi.fn(() => "docgen-output");
    const docgen = docgenPlugin(original);
    await runViteFinal({ plugins: [other, [docgen]] });
    expect(other.transform).toBe(otherTransform);
    expect(docgen.transform).not.toBe(original);
  });

  it("throws when no docgen plugin is present", async () => {
    await expect(
      runViteFinal({ plugins: [{ name: "other-plugin" } as Plugin] })
    ).rejects.toThrow(DOCGEN_PLUGIN_NAME);
  });

  it("throws when the plugin list is missing", async () => {
    await expect(runViteFinal({})).rejects.toThrow(
      "no longer contains a plugin named"
    );
  });

  // ISS-12676: docgen runs ahead of the transform phase in production only.
  describe("precompute-docgen wiring", () => {
    it("adds the precompute plugin and wraps the docgen transform in production", async () => {
      const original = vi.fn();
      const typescriptDocgen = docgenTsPlugin(original);
      const result = await runViteFinal(
        { plugins: [docgenPlugin(vi.fn()), [typescriptDocgen]] },
        "PRODUCTION"
      );
      expect(pluginNames(result)).toContain(PRECOMPUTE_PLUGIN_NAME);
      expect(typescriptDocgen.transform).not.toBe(original);
    });

    it("leaves the docgen plugin alone in development", async () => {
      const original = vi.fn();
      const typescriptDocgen = docgenTsPlugin(original);
      const result = await runViteFinal(
        { plugins: [docgenPlugin(vi.fn()), typescriptDocgen] },
        "DEVELOPMENT"
      );
      expect(pluginNames(result)).not.toContain(PRECOMPUTE_PLUGIN_NAME);
      expect(typescriptDocgen.transform).toBe(original);
    });

    it("throws in production when the TypeScript docgen plugin is missing", async () => {
      await expect(
        runViteFinal({ plugins: [docgenPlugin(vi.fn())] }, "PRODUCTION")
      ).rejects.toThrow(DOCGEN_TS_PLUGIN_NAME);
    });
  });

  describe("release-docgen-heap renderStart", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      calls.length = 0;
    });

    it("forces a memory-reducing GC when chunk rendering starts", async () => {
      const renderStart = await releaseHeapRenderStart();
      expect(gc).not.toHaveBeenCalled();
      renderStart();
      expect(calls).toEqual(["--expose-gc", "globalThis.gc", "--no-expose-gc"]);
      expect(gc).toHaveBeenCalledWith({
        type: "major",
        execution: "sync",
        flavor: "last-resort",
      });
    });

    it("skips the GC instead of throwing when gc is not exposed", async () => {
      const renderStart = await releaseHeapRenderStart();
      runInNewContext.mockReturnValueOnce(undefined);
      expect(renderStart).not.toThrow();
      expect(gc).not.toHaveBeenCalled();
    });
  });
});

// ISS-12145: the docgen plugin roots its TypeScript program at
// `globSync(include, { cwd: apps/storybook, ignore: exclude })`, run with the
// glob it depends on, and filters its transform with `createFilter(include,
// exclude)`. Both are replayed here with the plugin's own copies.
describe("storybook main.ts docgen program roots", () => {
  it("roots every include match except test and story files, in every workspace", () => {
    const { include, exclude } = docgenScope();
    const roots = globRoots(include, exclude);
    const everyMatch = globRoots(include, []);
    expect(roots.size).toBeGreaterThan(0);
    expect([...roots].filter(isTestOrStory)).toEqual([]);
    expect([...roots].sort()).toEqual(
      [...everyMatch].filter((file) => !isTestOrStory(file)).sort()
    );
    expect([...everyMatch].some(isOutsideStorybookTestOrStory)).toBe(true);
  });

  it("transforms every root and no story or test file", () => {
    const { include, exclude } = docgenScope();
    const transforms = createFilter(include, exclude);
    const everyMatch = [...globRoots(include, [])];
    expect(
      everyMatch.filter((f) => !(isTestOrStory(f) || transforms(f)))
    ).toEqual([]);
    expect(everyMatch.filter((f) => isTestOrStory(f) && transforms(f))).toEqual(
      []
    );
  });
});

async function releaseHeapRenderStart(): Promise<() => void> {
  const result = await runViteFinal({ plugins: [docgenPlugin(vi.fn())] });
  const release = result.plugins
    ?.flat()
    .find((p) => (p as Plugin)?.name === RELEASE_HEAP_PLUGIN_NAME) as Plugin;
  return release.renderStart as () => void;
}

function docgenScope(): { include: string[]; exclude: string[] } {
  const options = config.typescript?.reactDocgenTypescriptOptions as {
    include: string[];
    exclude: string[];
  };
  return { include: options.include, exclude: options.exclude };
}

function globRoots(include: string[], exclude: string[]): Set<string> {
  const roots = new Set<string>();
  for (const pattern of include) {
    for (const file of docgenPluginGlob()(pattern, {
      absolute: true,
      cwd: STORYBOOK_ROOT,
      ignore: exclude,
      nodir: true,
    })) {
      roots.add(file);
    }
  }
  return roots;
}

function isTestOrStory(file: string): boolean {
  return TEST_OR_STORY_FILE.test(file);
}

function isOutsideStorybookTestOrStory(file: string): boolean {
  return isTestOrStory(file) && !file.startsWith(STORYBOOK_ROOT);
}

const STORYBOOK_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_OR_STORY_FILE = /(\.stories\.tsx|\.test\.tsx?)$|\/__tests__\//;
