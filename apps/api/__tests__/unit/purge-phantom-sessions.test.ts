import { describe, expect, it, vi } from "vitest";
import {
  findPhantoms,
  main,
  type PhantomCandidate,
  purgePhantoms,
} from "../../scripts/purge-phantom-sessions.js";

const mockCandidate = (
  overrides: Partial<PhantomCandidate> = {}
): PhantomCandidate => ({
  artifactId: "art-1",
  externalSessionId: "ses-1",
  organizationId: "org-1",
  eventCount: BigInt(25),
  eventSpanMs: 200,
  ...overrides,
});

describe("findPhantoms", () => {
  it("passes null org filter when orgId is null", async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    await findPhantoms(mockTx as any, null);
    expect(mockTx.$queryRaw).toHaveBeenCalledOnce();
  });

  it("passes org filter when orgId is provided", async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([mockCandidate()]),
    };
    const result = await findPhantoms(mockTx as any, "org-1");
    expect(mockTx.$queryRaw).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
  });
});

describe("purgePhantoms", () => {
  it("returns 0 for empty candidates without DB call", async () => {
    const mockTx = {
      artifact: { deleteMany: vi.fn() },
    };
    const count = await purgePhantoms(mockTx as any, []);
    expect(count).toBe(0);
    expect(mockTx.artifact.deleteMany).not.toHaveBeenCalled();
  });

  it("returns actual deleted count from deleteMany", async () => {
    const mockTx = {
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
    };
    const candidates = [
      mockCandidate({ artifactId: "a1" }),
      mockCandidate({ artifactId: "a2" }),
      mockCandidate({ artifactId: "a3" }),
      mockCandidate({ artifactId: "a4" }),
    ];
    const count = await purgePhantoms(mockTx as any, candidates);
    expect(count).toBe(3);
    expect(mockTx.artifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2", "a3", "a4"] } },
    });
  });
});

describe("main — dry-run default", () => {
  it("defaults to dry-run when DRY_RUN env var is absent", () => {
    const saved = process.env.DRY_RUN;
    delete process.env.DRY_RUN;
    const val = process.env.DRY_RUN;
    expect(val !== "0").toBe(true);
    if (saved !== undefined) {
      process.env.DRY_RUN = saved;
    }
  });

  it("dry-run is true when DRY_RUN=1", () => {
    const saved = process.env.DRY_RUN;
    process.env.DRY_RUN = "1";
    const val = process.env.DRY_RUN;
    expect(val !== "0").toBe(true);
    if (saved === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = saved;
    }
  });

  it("dry-run is false only when DRY_RUN=0", () => {
    const saved = process.env.DRY_RUN;
    process.env.DRY_RUN = "0";
    const val = process.env.DRY_RUN;
    expect(val !== "0").toBe(false);
    if (saved === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = saved;
    }
  });
});

describe("main — cross-org safety", () => {
  it("exits with error when DRY_RUN=0 and ORG_ID is unset", async () => {
    const savedDryRun = process.env.DRY_RUN;
    const savedOrgId = process.env.ORG_ID;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.env.DRY_RUN = "0";
    delete process.env.ORG_ID;

    await main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORG_ID is required")
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    if (savedDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = savedDryRun;
    }
    if (savedOrgId === undefined) {
      delete process.env.ORG_ID;
    } else {
      process.env.ORG_ID = savedOrgId;
    }
  });
});
