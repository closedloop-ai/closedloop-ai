import { describe, expect, it } from "vitest";
import { z } from "zod";
import { expectIssue, ZodIssueCode } from "./zod-issues.js";

const NO_ISSUE_AT_PATH = /expected a rejection at path/;
const WRONG_CODE = /expected code "invalid_format"/;
const REQUIRES_MINIMUM = /requires "minimum"/;
const REQUIRES_ORIGIN = /requires "origin"/;
const REQUIRES_VALUES = /requires "values"/;
const UNRECOGNISED_CODE = /unrecognised Zod issue code/;
const WRONG_ORIGIN = /issue\.origin/;
const WRONG_MINIMUM = /issue\.minimum/;
const WRONG_VALUES = /issue\.values/;
const WRONG_MEMBER_FORMATS = /issue member formats/;
const NEVER_REGISTERED = /schema was never registered/;
const PARSED_INSTEAD = /expected the schema to REJECT/;

const SINGLE = z.object({ name: z.string().min(1) });
const MULTI = z.object({
  code: z
    .string()
    .min(1)
    .max(5)
    .regex(/^[a-z]+$/),
});
const CHOICE = z.object({ pick: z.enum(["alpha", "beta", "gamma"]) });
const INDEXED = z.array(z.object({ label: z.string().min(1) }));
const UNION = z.object({
  when: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
});

describe("expectIssue", () => {
  it("passes when the path, code and discriminator all match", () => {
    expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
      code: ZodIssueCode.TooSmall,
      origin: "string",
      minimum: 1,
    });
  });

  it("fails when nothing rejected at the requested path", () => {
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "" }), ["nickname"], {
        code: ZodIssueCode.TooSmall,
        origin: "string",
        minimum: 1,
      })
    ).toThrow(NO_ISSUE_AT_PATH);
  });

  it("fails when the right path carries a different code", () => {
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
        code: ZodIssueCode.InvalidFormat,
        format: "uuid",
      })
    ).toThrow(WRONG_CODE);
  });

  it("fails when the path and code match but a discriminator does not", () => {
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
        code: ZodIssueCode.TooSmall,
        origin: "number",
        minimum: 1,
      })
    ).toThrow(WRONG_ORIGIN);
  });

  it("selects by code when one path carries several issues", () => {
    const result = MULTI.safeParse({ code: "AAAAAAA" });
    // Both fire at ["code"]: too_big first, then the regex. Taking the first
    // issue at the path would make this assertion order-dependent.
    expectIssue(result, ["code"], {
      code: ZodIssueCode.InvalidFormat,
      format: "regex",
      origin: "string",
    });
    expectIssue(result, ["code"], {
      code: ZodIssueCode.TooBig,
      origin: "string",
      maximum: 5,
    });
  });

  it("throws when the code family's discriminator was omitted", () => {
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
        code: ZodIssueCode.TooSmall,
        origin: "string",
      })
    ).toThrow(REQUIRES_MINIMUM);
    expect(() =>
      expectIssue(CHOICE.safeParse({ pick: "delta" }), ["pick"], {
        code: ZodIssueCode.InvalidValue,
      })
    ).toThrow(REQUIRES_VALUES);
  });

  it("allowUnpinnedBound excuses only the bound, not the origin", () => {
    expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
      code: ZodIssueCode.TooSmall,
      origin: "string",
      allowUnpinnedBound: true,
    });
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
        code: ZodIssueCode.TooSmall,
        allowUnpinnedBound: true,
      })
    ).toThrow(REQUIRES_ORIGIN);
  });

  it("allowUnpinnedBound still checks a bound that IS supplied", () => {
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
        code: ZodIssueCode.TooSmall,
        origin: "string",
        minimum: 99,
        allowUnpinnedBound: true,
      })
    ).toThrow(WRONG_MINIMUM);
  });

  it("compares values as an order-independent set", () => {
    const result = CHOICE.safeParse({ pick: "delta" });
    expectIssue(result, ["pick"], {
      code: ZodIssueCode.InvalidValue,
      values: ["gamma", "alpha", "beta"],
    });
    expect(() =>
      expectIssue(result, ["pick"], {
        code: ZodIssueCode.InvalidValue,
        values: ["alpha", "beta"],
      })
    ).toThrow(WRONG_VALUES);
  });

  it("distinguishes a numeric array index from its string spelling", () => {
    const result = INDEXED.safeParse([{ label: "" }]);
    expectIssue(result, [0, "label"], {
      code: ZodIssueCode.TooSmall,
      origin: "string",
      minimum: 1,
    });
    expect(() =>
      expectIssue(result, ["0", "label"], {
        code: ZodIssueCode.TooSmall,
        origin: "string",
        minimum: 1,
      })
    ).toThrow(NO_ISSUE_AT_PATH);
  });

  it("reads member formats out of an invalid_union", () => {
    const result = UNION.safeParse({ when: "2026-07-32" });
    expectIssue(result, ["when"], {
      code: ZodIssueCode.InvalidUnion,
      memberFormats: ["datetime", "date"],
    });
    expect(() =>
      expectIssue(result, ["when"], {
        code: ZodIssueCode.InvalidUnion,
        memberFormats: ["date"],
      })
    ).toThrow(WRONG_MEMBER_FORMATS);
  });

  it("throws on a Zod issue code it does not know how to discriminate", () => {
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "" }), ["name"], {
        // Cast: the point of the guard is a code the union does not admit,
        // which is reachable because tsc never sees this directory.
        code: "not_multiple_of" as never,
      })
    ).toThrow(UNRECOGNISED_CODE);
  });

  it("fails loudly when the schema was never registered", () => {
    expect(() =>
      expectIssue(undefined, [], {
        code: ZodIssueCode.InvalidType,
        expected: "string",
      })
    ).toThrow(NEVER_REGISTERED);
  });

  it("fails when the input parsed instead of being rejected", () => {
    expect(() =>
      expectIssue(SINGLE.safeParse({ name: "ok" }), ["name"], {
        code: ZodIssueCode.TooSmall,
        origin: "string",
        minimum: 1,
      })
    ).toThrow(PARSED_INSTEAD);
  });
});
