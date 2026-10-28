import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  delegate: (_accessor: string): unknown => ({
    count: () => Promise.resolve(0),
  }),
  disconnects: 0,
  accessors: [] as string[],
}));

vi.mock("../src/main/database/generated/client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/main/database/generated/client.js")
  >()),
  PrismaClient: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: a Proxy stands in for every model delegate
      return new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === "$disconnect") {
              return () => {
                fake.disconnects += 1;
                return Promise.resolve();
              };
            }
            fake.accessors.push(String(key));
            return fake.delegate(String(key));
          },
        }
      );
    }
  },
}));

import {
  modelAccessor,
  readDesktopRowCounts,
} from "../scripts/vibe-profile/row-counts";
import { Prisma } from "../src/main/database/generated/client.js";

const dirs: string[] = [];

beforeEach(() => {
  fake.disconnects = 0;
  fake.accessors = [];
  fake.delegate = () => ({ count: () => Promise.resolve(0) });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function storeFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-row-counts-"));
  dirs.push(dir);
  const file = path.join(dir, "store.db");
  writeFileSync(file, "");
  return file;
}

describe("readDesktopRowCounts", () => {
  it("keys each count by model name, read through the lower-camel accessor, then disconnects", async () => {
    fake.delegate = (accessor) => ({
      count: () => Promise.resolve(accessor.length),
    });

    const counts = await readDesktopRowCounts(storeFile());

    const models = Object.values(Prisma.ModelName);
    expect(Object.keys(counts)).toEqual(models);
    for (const model of models) {
      expect(counts[model]).toBe(modelAccessor(model).length);
    }
    expect(fake.accessors).toEqual(models.map(modelAccessor));
    expect(fake.disconnects).toBe(1);
  });

  it.each([
    ["null", null],
    ["a non-object", 7],
    ["an object without a count function", { count: 3 }],
  ])(
    "rejects a delegate that is %s and still disconnects",
    async (_label, delegate) => {
      fake.delegate = () => delegate;

      await expect(readDesktopRowCounts(storeFile())).rejects.toThrow();
      expect(fake.disconnects).toBe(1);
    }
  );
});

describe("modelAccessor", () => {
  it("lowercases only the first character", () => {
    expect(modelAccessor("AgentComponent")).toBe("agentComponent");
    expect(modelAccessor("X")).toBe("x");
  });
});
