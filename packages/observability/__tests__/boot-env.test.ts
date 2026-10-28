import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blankAsUndefined,
  EnvValidationError,
  envIssuesFrom,
  exactOriginListSchema,
  loadEnvOrExit,
} from "../boot-env";
import { log } from "../log";

const INVALID = { message: "refused to boot", event: "svc.env_invalid" };

describe("loadEnvOrExit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed value without logging, flushing or exiting", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const exit = vi.fn();
    const flushLogs = vi.fn(() => Promise.resolve());

    await expect(
      loadEnvOrExit(() => ({ port: 1 }), INVALID, { exit, flushLogs })
    ).resolves.toEqual({ port: 1 });

    expect(error).not.toHaveBeenCalled();
    expect(flushLogs).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs the validation issues as a fatal, then flushes, then exits 1", async () => {
    const order: string[] = [];
    const error = vi.spyOn(log, "error").mockImplementation(() => {
      order.push("log");
    });
    const flushLogs = vi.fn(() => {
      order.push("flush");
      return Promise.resolve();
    });
    const exit = vi.fn(() => {
      order.push("exit");
    });
    const issues = [{ key: "PORT", message: "too big" }];

    const result = await loadEnvOrExit(
      () => {
        throw new EnvValidationError("svc", issues);
      },
      INVALID,
      { exit, flushLogs }
    );

    expect(result).toBeUndefined();
    expect(order).toEqual(["log", "flush", "exit"]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(INVALID.message, {
      event: INVALID.event,
      fatal: true,
      issues,
    });
  });

  it("reports any other throw as one generic issue, without its message", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const exit = vi.fn();

    await loadEnvOrExit(
      () => {
        throw new Error("secret-value");
      },
      INVALID,
      { exit, flushLogs: () => Promise.resolve() }
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(INVALID.message, {
      event: INVALID.event,
      fatal: true,
      issues: [{ key: "env", message: "unexpected validation failure" }],
    });
  });
});

describe("envIssuesFrom", () => {
  it("keys each issue by its root path segment, falling back to env", () => {
    expect(
      envIssuesFrom([
        { path: ["PORT", 0], message: "bad" },
        { path: [], message: "cross-field" },
      ])
    ).toEqual([
      { key: "PORT", message: "bad" },
      { key: "env", message: "cross-field" },
    ]);
  });
});

describe("blankAsUndefined", () => {
  it("reads a whitespace-only string as unset and passes everything else through", () => {
    expect(blankAsUndefined("  ")).toBeUndefined();
    expect(blankAsUndefined("")).toBeUndefined();
    expect(blankAsUndefined(" 0 ")).toBe(" 0 ");
    expect(blankAsUndefined(0)).toBe(0);
  });
});

describe("exactOriginListSchema", () => {
  const schema = exactOriginListSchema("SVC_ALLOWED_ORIGINS");

  it("splits, trims and drops blank entries", () => {
    expect(
      schema.parse(" http://localhost:3000 , ,https://app.example.test:8443")
    ).toEqual(["http://localhost:3000", "https://app.example.test:8443"]);
  });

  it("reads an unset or blank value as an empty list", () => {
    expect(schema.parse(undefined)).toEqual([]);
    expect(schema.parse("  ")).toEqual([]);
  });

  it.each([
    "https://app.example.test/path",
    "https://app.example.test/",
    "app.example.test",
  ])("refuses %s with an issue naming the key", (entry) => {
    const parsed = schema.safeParse(`http://localhost:3000,${entry}`);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      "SVC_ALLOWED_ORIGINS entries must be bare origins (scheme://host[:port])",
    ]);
  });
});
