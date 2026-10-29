import { z } from "zod";
import { log } from "./log";
import { flushLogsWithDeadline } from "./shutdown";

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Names the key and never echoes the value, since most are secrets. */
export type EnvIssue = { key: string; message: string };

export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(service: string, issues: readonly EnvIssue[]) {
    super(
      `Invalid ${service} environment: ${issues.map((issue) => issue.key).join(", ")}`
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/** Keys each schema issue by the env variable at the root of its path. */
export function envIssuesFrom(
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
): EnvIssue[] {
  return issues.map((issue) => ({
    key: String(issue.path[0] ?? "env"),
    message: issue.message,
  }));
}

export type FatalExitDeps = {
  exit: (code: number) => void;
  flushLogs: () => Promise<void>;
};

export type EnvInvalidLog = { message: string; event: string };

/**
 * Boot entry: a parse that throws logs a structured fatal (`event`,
 * `fatal: true`, `issues`), flushes, then exits 1.
 */
export async function loadEnvOrExit<T>(
  parse: () => T,
  invalid: EnvInvalidLog,
  deps: FatalExitDeps = {
    exit: (code) => process.exit(code),
    flushLogs: flushLogsWithDeadline,
  }
): Promise<T | undefined> {
  try {
    return parse();
  } catch (error) {
    const issues =
      error instanceof EnvValidationError
        ? error.issues
        : [{ key: "env", message: "unexpected validation failure" }];
    log.error(invalid.message, { event: invalid.event, fatal: true, issues });
    await deps.flushLogs();
    deps.exit(1);
    return undefined;
  }
}

/** A blank value is read as unset, the convention every env schema in this repo follows. */
export const blankAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/**
 * A comma-separated list of exact browser origins (`scheme://host[:port]`).
 * Blank entries are dropped and an unset value is an empty list; an entry that
 * is not a bare origin is an issue naming `key`.
 */
export const exactOriginListSchema = (key: string) =>
  z
    .preprocess(blankAsUndefined, z.string().optional())
    .transform((raw, ctx): readonly string[] => {
      const origins = (raw ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (!origins.every(isExactOrigin)) {
        ctx.addIssue({
          code: "custom",
          message: `${key} entries must be bare origins (scheme://host[:port])`,
        });
        return z.NEVER;
      }
      return origins;
    });

function isExactOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).origin === value;
}
