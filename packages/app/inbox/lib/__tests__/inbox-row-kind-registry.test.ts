import { describe, expect, it } from "vitest";
import { createInboxRowKindRegistry } from "../inbox-row-kind-registry";

/**
 * ISS-9406 — the registry's one job: an index by a key off the wire is total.
 * Written over marker strings, because a test that can only state the rule by
 * importing the table it polices is restating the table.
 */

/**
 * Keys nobody registers and every object nonetheless answers. Literals, because
 * deriving them from `Object.prototype` would shrink the expectation to
 * whatever that object happens to expose.
 */
const INHERITED_KEYS = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
] as const;

const REGISTERED = { $assignment: "assignment-row", $mention: "mention-row" };

describe("createInboxRowKindRegistry", () => {
  it("answers nothing for keys it never registered, where a literal answers with a prototype member", () => {
    const registry = createInboxRowKindRegistry(REGISTERED) as Record<
      string,
      unknown
    >;
    // The control: without it this suite would keep passing if these ever left
    // `Object.prototype`, at which point the hazard — and this test — is gone.
    const literal = { ...REGISTERED } as Record<string, unknown>;

    for (const key of INHERITED_KEYS) {
      expect(literal[key], `literal.${key}`).toBeDefined();
      expect(registry[key], `registry.${key}`).toBeUndefined();
    }
  });

  it("still resolves the kinds it was given", () => {
    const registry = createInboxRowKindRegistry(REGISTERED);

    expect(registry.$assignment).toBe("assignment-row");
    expect(registry.$mention).toBe("mention-row");
  });

  it("cannot be extended after it is built", () => {
    const registry = createInboxRowKindRegistry(REGISTERED) as Record<
      string,
      unknown
    >;

    expect(() => {
      registry.$assignment = "replaced";
    }).toThrow();
    expect(registry.$assignment).toBe("assignment-row");
  });
});
