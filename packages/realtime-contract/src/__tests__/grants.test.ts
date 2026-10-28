import { describe, expect, it } from "vitest";
import { type Grant, GrantAccess, matchGrant } from "../grants";

const ORG_A = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const ORG_B = "01a0e868-745c-763d-9f66-5f01fa7562e5";

const readA: Grant[] = [
  { pattern: `comments:${ORG_A}:*`, access: GrantAccess.Read },
];

describe("matchGrant", () => {
  it("allows an address in the token's own org", () => {
    expect(
      matchGrant(readA, `comments:${ORG_A}:artifact-1`, GrantAccess.Read, ORG_A)
    ).toBe(true);
  });

  it("denies an address in another org even when a grant names that org", () => {
    const readB: Grant[] = [
      { pattern: `comments:${ORG_B}:*`, access: GrantAccess.Read },
    ];
    expect(
      matchGrant(readB, `comments:${ORG_B}:artifact-1`, GrantAccess.Read, ORG_A)
    ).toBe(false);
  });

  it("denies another org's address against the token org's grant", () => {
    expect(
      matchGrant(readA, `comments:${ORG_B}:artifact-1`, GrantAccess.Read, ORG_B)
    ).toBe(false);
  });

  it("denies write with a read grant and allows read with a write grant", () => {
    expect(
      matchGrant(
        readA,
        `comments:${ORG_A}:artifact-1`,
        GrantAccess.Write,
        ORG_A
      )
    ).toBe(false);
    const writeA: Grant[] = [
      { pattern: `presence:${ORG_A}:*`, access: GrantAccess.Write },
    ];
    expect(
      matchGrant(writeA, `presence:${ORG_A}:doc-1`, GrantAccess.Read, ORG_A)
    ).toBe(true);
    expect(
      matchGrant(writeA, `presence:${ORG_A}:doc-1`, GrantAccess.Write, ORG_A)
    ).toBe(true);
  });

  it("matches * only as the final segment, and only one segment", () => {
    expect(
      matchGrant(readA, `comments:${ORG_A}:a:b`, GrantAccess.Read, ORG_A)
    ).toBe(false);
    const midWildcard: Grant[] = [
      { pattern: `comments:${ORG_A}:*:b`, access: GrantAccess.Read },
    ];
    expect(
      matchGrant(midWildcard, `comments:${ORG_A}:a:b`, GrantAccess.Read, ORG_A)
    ).toBe(false);
    const kindWildcard: Grant[] = [
      { pattern: `*:${ORG_A}:a`, access: GrantAccess.Read },
    ];
    expect(
      matchGrant(kindWildcard, `comments:${ORG_A}:a`, GrantAccess.Read, ORG_A)
    ).toBe(false);
  });

  it("matches an exact pattern and denies a different kind", () => {
    const exact: Grant[] = [
      { pattern: `inbox:${ORG_A}:user-1`, access: GrantAccess.Read },
    ];
    expect(
      matchGrant(exact, `inbox:${ORG_A}:user-1`, GrantAccess.Read, ORG_A)
    ).toBe(true);
    expect(
      matchGrant(exact, `inbox:${ORG_A}:user-2`, GrantAccess.Read, ORG_A)
    ).toBe(false);
    expect(
      matchGrant(readA, `inbox:${ORG_A}:user-1`, GrantAccess.Read, ORG_A)
    ).toBe(false);
  });

  it("denies a malformed address", () => {
    const everything: Grant[] = [
      { pattern: "comments:not-a-uuid:*", access: GrantAccess.Write },
    ];
    expect(
      matchGrant(
        everything,
        "comments:not-a-uuid:x",
        GrantAccess.Read,
        "not-a-uuid"
      )
    ).toBe(false);
  });
});
