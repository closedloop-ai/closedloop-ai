/**
 * Zod rejection assertion for the MCP tool suites.
 *
 * `expect(schema.safeParse(bad).success).toBe(false)` passes for ANY rejection
 * reason, so a schema-wide typo keeps it green (ISS-7607). `expectIssue` pins
 * WHICH field rejected and WHY.
 *
 * Two constraints shape the design:
 *
 * 1. One path can carry SEVERAL issues — `z.string().min(1).max(5).regex(...)`
 *    reports `too_big` AND `invalid_format` at the same path — so selecting
 *    "the first issue at this path" would still be order-dependent. Selection
 *    is by (path, code).
 * 2. `apps/mcp/tsconfig.json` excludes `src/__tests__`, so nothing typechecks
 *    these call sites. A site written `{ code: "too_big" }` with no bound would
 *    silently under-assert and no gate would catch it, which is the very defect
 *    class this helper exists to remove. So `expectIssue` THROWS when the code
 *    family's discriminator is missing.
 */

import { expect } from "vitest";

/** The Zod 4 issue codes these suites assert against. */
export const ZodIssueCode = {
  InvalidFormat: "invalid_format",
  InvalidType: "invalid_type",
  InvalidUnion: "invalid_union",
  InvalidValue: "invalid_value",
  TooBig: "too_big",
  TooSmall: "too_small",
} as const;
export type ZodIssueCode = (typeof ZodIssueCode)[keyof typeof ZodIssueCode];

/** Zod reports array indices as numbers, so `[0, "x"]` is not `["0", "x"]`. */
export type IssuePath = PropertyKey[];

export type ExpectedIssue = {
  code: ZodIssueCode;
  format?: string;
  origin?: string;
  prefix?: string;
  expected?: string;
  minimum?: number;
  maximum?: number;
  values?: readonly unknown[];
  /** Sorted set of the `format` of every nested member issue of an `invalid_union`. */
  memberFormats?: readonly string[];
  /**
   * Opt out of the bound requirement for `too_small`/`too_big`. Reserved for the
   * two caps `apps/mcp/src/tools/get-document-content.ts` keeps module-private;
   * every other site must pin its bound.
   */
  allowUnpinnedBound?: boolean;
};

type ZodIssueLike = {
  code: string;
  path: PropertyKey[];
  message: string;
  format?: string;
  origin?: string;
  prefix?: string;
  expected?: string;
  minimum?: unknown;
  maximum?: unknown;
  values?: unknown[];
  errors?: ZodIssueLike[][];
};

type ParseResultLike =
  | { success: true }
  | { success: false; error: { issues: readonly ZodIssueLike[] } };

const REQUIRED_KEYS: Record<ZodIssueCode, (keyof ExpectedIssue)[]> = {
  [ZodIssueCode.InvalidFormat]: ["format"],
  [ZodIssueCode.InvalidType]: ["expected"],
  [ZodIssueCode.InvalidUnion]: ["memberFormats"],
  [ZodIssueCode.InvalidValue]: ["values"],
  [ZodIssueCode.TooBig]: ["origin", "maximum"],
  [ZodIssueCode.TooSmall]: ["origin", "minimum"],
};

const UNPINNABLE_KEYS = new Set(["minimum", "maximum"]);

const SCALAR_KEYS = [
  "format",
  "origin",
  "prefix",
  "expected",
  "minimum",
  "maximum",
] as const;

function samePath(left: PropertyKey[], right: PropertyKey[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describeIssues(issues: readonly ZodIssueLike[]): string {
  return JSON.stringify(
    issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.message,
    })),
    null,
    2
  );
}

function requireDiscriminators(expected: ExpectedIssue): void {
  if (!Object.hasOwn(REQUIRED_KEYS, expected.code)) {
    throw new Error(
      `expectIssue: unrecognised Zod issue code "${expected.code}". Add it to REQUIRED_KEYS with the discriminator that identifies it, so the new family cannot be asserted by code alone.`
    );
  }
  for (const key of REQUIRED_KEYS[expected.code]) {
    const supplied = expected[key] !== undefined;
    const excused = expected.allowUnpinnedBound && UNPINNABLE_KEYS.has(key);
    if (supplied || excused) {
      continue;
    }
    throw new Error(
      `expectIssue: code "${expected.code}" requires "${key}". Asserting the code alone under-specifies the rejection, and nothing typechecks this call site.`
    );
  }
}

function sortedStrings(values: readonly unknown[]): string[] {
  return values.map(String).sort();
}

function memberFormatsOf(issue: ZodIssueLike): string[] {
  return (issue.errors ?? [])
    .flat()
    .map((nested) => nested.format ?? nested.code);
}

/**
 * Assert the schema rejected at `path`, for the reason `expected.code`, with the
 * discriminator that separates that reason from its siblings.
 */
export function expectIssue(
  result: ParseResultLike | undefined,
  path: IssuePath,
  expected: ExpectedIssue
): void {
  requireDiscriminators(expected);

  expect(
    result,
    "schema was never registered — safeParse returned undefined"
  ).toBeDefined();
  const parsed = result as ParseResultLike;
  expect(
    parsed.success,
    "expected the schema to REJECT this input, but it parsed"
  ).toBe(false);

  const issues = (parsed as { error: { issues: readonly ZodIssueLike[] } })
    .error.issues;
  const atPath = issues.filter((issue) => samePath(issue.path, path));
  expect(
    atPath.length,
    `expected a rejection at path ${JSON.stringify(path)}, but the issues were:\n${describeIssues(issues)}`
  ).toBeGreaterThan(0);

  const found = atPath.find((issue) => issue.code === expected.code);
  expect(
    found,
    `expected code "${expected.code}" at path ${JSON.stringify(path)}, but that path carried:\n${describeIssues(atPath)}`
  ).toBeDefined();

  const issue = found as ZodIssueLike;
  for (const key of SCALAR_KEYS) {
    const value = expected[key];
    if (value !== undefined) {
      expect(issue[key], `issue.${key}`).toBe(value);
    }
  }
  if (expected.values !== undefined) {
    expect(sortedStrings(issue.values ?? []), "issue.values").toEqual(
      sortedStrings(expected.values)
    );
  }
  if (expected.memberFormats !== undefined) {
    expect(
      sortedStrings(memberFormatsOf(issue)),
      "issue member formats"
    ).toEqual(sortedStrings(expected.memberFormats));
  }
}

/** `z.string().uuid()` / `z.uuid()` refusing a non-UUID. */
export const UUID_REJECTION: ExpectedIssue = {
  code: ZodIssueCode.InvalidFormat,
  format: "uuid",
};

/** `z.string().min(1)` refusing an empty string. */
export const NON_EMPTY_STRING_REJECTION: ExpectedIssue = {
  code: ZodIssueCode.TooSmall,
  origin: "string",
  minimum: 1,
};

/**
 * The shared `dueDate` union (`z.iso.date()` | `z.iso.datetime({offset:true})`)
 * refusing a value that matches neither member.
 */
export const ISO_DATE_UNION_REJECTION: ExpectedIssue = {
  code: ZodIssueCode.InvalidUnion,
  memberFormats: ["date", "datetime"],
};
