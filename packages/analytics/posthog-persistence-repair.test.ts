/**
 * ISS-8660: the repair decisions, unit-level.
 *
 * The sibling `posthog-persistence-guard.test.tsx` drives these through a real
 * posthog-js client and asserts capture survives. This file pins the two things
 * that are decisions rather than outcomes, and that a capture-level assertion
 * cannot distinguish:
 *
 *  - WHICH stored shapes count as a record at all, now that a hand-written
 *    predicate replaced two Zod schemas (codex review). That swap is a
 *    behaviour change with a real regression risk in both directions — accept
 *    something Zod rejected and the guard rewrites a record it does not
 *    understand; reject something Zod accepted and a poisoned browser stays
 *    broken — so the table below is the schemas' own measured verdicts,
 *    recorded from `safeParse` before they were deleted.
 *  - That a value with nothing sensitive in it comes back BYTE-IDENTICAL.
 *    Redaction that silently rewrites healthy URLs would be invisible to a
 *    "does capture still work" test and would corrupt every referrer we hold.
 */
import { describe, expect, it } from "vitest";
import {
  PERSISTED_PERSON_INFO_SITES,
  PersistedPersonInfoKey,
} from "./posthog-persistence-repair";

const SESSION_ID = "0198c0de-0000-7000-8000-000000000002";
const HEALTHY_URL = "http://localhost:3000/acme/sessions?tab=open&sort=age";
const HEALTHY_REFERRER = "https://www.google.com/search?q=closedloop";

/**
 * Verdicts of the deleted `z.looseObject({})` on every shape reachable here,
 * measured against zod 4 rather than assumed. `Object.create(null)` is in the
 * list because `JSON.parse` reviver output and posthog-js's own dispatch tables
 * can produce one, and a naive `instanceof Object` predicate would reject it.
 */
const RECORD_SHAPES: readonly [
  name: string,
  value: unknown,
  isRecord: boolean,
][] = [
  ["plain object", { r: "a" }, true],
  ["empty object", {}, true],
  [
    "null-prototype object",
    Object.assign(Object.create(null), { r: "a" }),
    true,
  ],
  ["array", [], false],
  ["populated array", [1, 2], false],
  ["string", "bad", false],
  ["number", 1, false],
  ["zero", 0, false],
  ["true", true, false],
  ["false", false, false],
  ["null", null, false],
  ["undefined", undefined, false],
];

const repairInitialPersonInfo = siteRepair(
  PersistedPersonInfoKey.InitialPersonInfo
);
const repairClientSessionProps = siteRepair(
  PersistedPersonInfoKey.ClientSessionProps
);

describe("which stored shapes the repair treats as a record", () => {
  it.each(RECORD_SHAPES)(
    "matches the schema it replaced for %s",
    (_name, value, isRecord) => {
      // A record carrying a poisoned `r` is repaired; a non-record is left
      // alone. So "was it repaired" IS the predicate's answer, observed through
      // the production entry point rather than by exporting the predicate.
      const stored =
        value && typeof value === "object"
          ? Object.assign(value as object, { r: 1 })
          : value;

      expect(repairInitialPersonInfo(stored) !== undefined).toBe(isRecord);
    }
  );
});

describe("a value with no sensitive query param", () => {
  it("is left byte-identical when the record is repaired for another reason", () => {
    const repair = repairClientSessionProps({
      sessionId: SESSION_ID,
      props: { r: HEALTHY_REFERRER, u: 12_345 },
    });

    // `u` was the poison and is gone; `r` had nothing to redact and must come
    // back as the same string, not a re-encoded round-trip of it.
    const props = (repair?.value.props ?? {}) as Record<string, unknown>;
    expect(props.r).toBe(HEALTHY_REFERRER);
    expect(repair?.redacted).toEqual([]);
  });

  it("does not make a healthy record look repairable", () => {
    expect(
      repairClientSessionProps({
        sessionId: SESSION_ID,
        props: { r: HEALTHY_REFERRER, u: HEALTHY_URL },
      })
    ).toBeUndefined();
  });

  it("leaves a referrer posthog-js stores as a non-URL alone", () => {
    // `getReferrer()` stores the literal `$direct`, which no URL parser accepts
    // — the reason the redaction is string surgery rather than `new URL`.
    expect(
      repairClientSessionProps({
        sessionId: SESSION_ID,
        props: { r: "$direct", u: HEALTHY_URL },
      })
    ).toBeUndefined();
  });
});

describe("a value written before ISS-8295 configured posthog-js masking", () => {
  it("is redacted in place, keeping the key, the path and every other param", () => {
    const repair = repairClientSessionProps({
      sessionId: SESSION_ID,
      props: {
        r: HEALTHY_REFERRER,
        u: "https://app.closedloop.ai/connect/github?provider=github&state=9f3c-csrf&next=/acme",
      },
    });

    const props = (repair?.value.props ?? {}) as Record<string, unknown>;
    expect(props.u).toBe(
      "https://app.closedloop.ai/connect/github?provider=github&state=[redacted]&next=/acme"
    );
    expect(repair?.redacted).toEqual(["u"]);
    // A migration, not the outage — the two must stay countable apart.
    expect(repair?.dropped).toEqual([]);
  });

  it("redacts a secret held in the referrer too", () => {
    const repair = repairClientSessionProps({
      sessionId: SESSION_ID,
      props: { r: "https://app.closedloop.ai/connect/github?code=abc123" },
    });

    const props = (repair?.value.props ?? {}) as Record<string, unknown>;
    expect(props.r).toBe(
      "https://app.closedloop.ai/connect/github?code=[redacted]"
    );
    expect(repair?.redacted).toEqual(["r"]);
  });

  it("reaches the same value under $initial_person_info", () => {
    const repair = repairInitialPersonInfo({
      r: HEALTHY_REFERRER,
      u: "https://app.closedloop.ai/c?redirect_url=https%3A%2F%2Fx%2F%3Fstate%3Ds",
    });

    expect(repair?.value.u).toBe(
      "https://app.closedloop.ai/c?redirect_url=[redacted]"
    );
  });
});

describe("a $client_session_props.props that is not an object", () => {
  it.each([
    ["a number", 1],
    ["a string", "bad"],
    ["true", true],
  ])("drops %s, which would throw in `'r' in p`", (_name, props) => {
    const repair = repairClientSessionProps({ sessionId: SESSION_ID, props });

    expect(repair?.value).toEqual({ sessionId: SESSION_ID });
    expect(repair?.value).not.toHaveProperty("props");
    expect(repair?.dropped).toEqual([
      { field: "props", valueType: typeof props },
    ]);
  });

  it.each([
    ["a falsy primitive", 0],
    ["null", null],
    ["an array", []],
  ])(
    "leaves %s alone, because `in` answers it without throwing",
    (_n, props) => {
      expect(
        repairClientSessionProps({ sessionId: SESSION_ID, props })
      ).toBeUndefined();
    }
  );
});

function siteRepair(key: PersistedPersonInfoKey) {
  const site = PERSISTED_PERSON_INFO_SITES.find((entry) => entry.key === key);
  if (!site) {
    throw new Error(`no repair site registered for ${key}`);
  }
  return site.repair;
}
