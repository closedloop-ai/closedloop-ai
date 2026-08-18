import { describe, expect, it } from "vitest";
import { DATE_REVIVAL_KEYS } from "../date-revival-keys";
import {
  discoverFixtureKeys,
  discoverFixtureSources,
  discoverResponseContractDateKeys,
  loadRepoSources,
} from "./date-revival-discovery";

/**
 * Keys-covered guard for the API client's date revival (ISS-5771).
 *
 * `DATE_REVIVAL_KEYS` decides, at the web/desktop parse boundary, which fields
 * become a `Date`. It is therefore load-bearing in BOTH directions:
 *
 * - a key in the list that no RESPONSE contract declares as a `Date` revives a
 *   field the contract says is a `string` — the original defect, which took the
 *   component detail page into its error boundary;
 * - a `Date`-typed response field whose key is MISSING from the list arrives as
 *   a `string` while `tsc` says `Date` — the same defect inverted.
 *
 * So this re-derives the truth from source and asserts set equality. What
 * counts as a response contract, and how a `Date` is recognized in each of the
 * two ways a contract spells one, lives in `date-revival-discovery.ts`.
 */

/**
 * Floors for the "guard the guard" assertions. Deliberately far below today's
 * real numbers: they exist to catch a scan that collapsed to nothing (a broken
 * path, a renamed wrapper), not to pin a count that legitimately moves.
 */
const MIN_ROUTE_PAYLOADS = 100;
const MIN_REACHED_DECLARATIONS = 200;
const MIN_DATE_KEYS = 20;

describe("DATE_REVIVAL_KEYS covers the response contract (ISS-5771)", () => {
  const discovered = discoverResponseContractDateKeys(loadRepoSources());

  it("reaches a non-trivial response surface", () => {
    // Guards the guard: a broken path resolution or a renamed route wrapper
    // would otherwise make every assertion below pass vacuously.
    expect(discovered.routePayloadCount).toBeGreaterThan(MIN_ROUTE_PAYLOADS);
    expect(discovered.reachedDeclarationCount).toBeGreaterThan(
      MIN_REACHED_DECLARATIONS
    );
    expect(discovered.keys.size).toBeGreaterThan(MIN_DATE_KEYS);
  });

  it("revives every key a response contract declares as a `Date`", () => {
    const missing = [...discovered.keys].filter(
      (key) => !DATE_REVIVAL_KEYS.has(key)
    );

    expect(
      missing,
      `These properties are declared \`Date\` on a type an API route serializes, but the API client would hand back a \`string\`. Add them to DATE_REVIVAL_KEYS: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("revives no key that no response contract declares as a `Date`", () => {
    const extra = [...DATE_REVIVAL_KEYS].filter(
      (key) => !discovered.keys.has(key)
    );

    expect(
      extra,
      `These keys are revived into \`Date\` but no route-served type declares them as one, so the runtime shape contradicts the contract. Remove them from DATE_REVIVAL_KEYS — or, if the field really is served by a route this scan cannot see (a handler that bypasses the route-auth wrappers), give that route its wrapper so its payload is declared where the guard can read it: ${extra.join(", ")}`
    ).toEqual([]);
  });

  it("has no array-of-Date response field, which the reviver cannot key", () => {
    // `JSON.parse` calls its reviver with the array INDEX for elements, so a
    // `Date[]` field would not revive through `reviveWithDates`. None exists
    // today; this fails if one is introduced so the gap cannot appear silently.
    expect(discovered.arrayKeys).toEqual([]);
  });
});

/**
 * The discovery contract, proved against synthetic sources.
 *
 * Every fixture key is minted for this suite and appears nowhere in the repo, so
 * a case cannot pass because some unrelated real contract happens to share the
 * name — which is exactly how the missing Zod support hid: `expiresAt` is also
 * declared explicitly on `ApiKey`, so the one inferred date in the tree was
 * covered by accident.
 */
describe("response-contract discovery (ISS-5771)", () => {
  it("reads an explicit `Date` property signature", () => {
    const keys = discoverFixtureKeys(
      "type FixturePayload = { explicitFixtureAt: Date };"
    );

    expect([...keys]).toContain("explicitFixtureAt");
  });

  it("reads a `z.coerce.date()` field behind a `z.infer` payload", () => {
    const keys = discoverFixtureKeys(
      `export const FixtureSchema = z.object({ coercedFixtureAt: z.coerce.date(), name: z.string() });
       type FixturePayload = z.infer<typeof FixtureSchema>;`
    );

    expect([...keys]).toContain("coercedFixtureAt");
    expect([...keys]).not.toContain("name");
  });

  it("reads a bare `z.date()` field and one behind a union", () => {
    const keys = discoverFixtureKeys(
      `export const FixtureSchema = z.object({
         bareFixtureAt: z.date(),
         unionFixtureAt: z.union([z.string(), z.date()]).transform((v) => v),
       });
       type FixturePayload = z.infer<typeof FixtureSchema>;`
    );

    expect([...keys]).toContain("bareFixtureAt");
    expect([...keys]).toContain("unionFixtureAt");
  });

  it("follows a nested schema reached from the payload schema", () => {
    const keys = discoverFixtureKeys(
      `export const NestedFixtureSchema = z.object({ nestedFixtureAt: z.coerce.date() });
       export const FixtureSchema = z.object({ nested: NestedFixtureSchema });
       type FixturePayload = z.infer<typeof FixtureSchema>;`
    );

    expect([...keys]).toContain("nestedFixtureAt");
  });

  it("ignores a schema no route payload reaches", () => {
    // The whole point of the seed: a `Date` that never crosses the wire must not
    // widen the allowlist, however it is spelled.
    const keys = discoverFixtureKeys(
      `export const StrandedSchema = z.object({ strandedFixtureAt: z.coerce.date() });
       export type StrandedPayload = z.infer<typeof StrandedSchema>;
       type FixturePayload = { explicitFixtureAt: Date };`
    );

    expect([...keys]).toContain("explicitFixtureAt");
    expect([...keys]).not.toContain("strandedFixtureAt");
  });

  it("ignores a callback parameter that merely mentions `Date`", () => {
    const keys = discoverFixtureKeys(
      "type FixturePayload = { onFixturePicked: (value: Date) => void };"
    );

    expect([...keys]).not.toContain("onFixturePicked");
  });

  it("reports an array-of-`Date` field, which the reviver cannot key", () => {
    const discovered = discoverFixtureSources(
      "type FixturePayload = { fixtureDatesAt: Date[] };"
    );

    expect(discovered.arrayKeys).toEqual(["fixtureDatesAt"]);
  });

  it("carries the owning key through a `string` type alias", () => {
    // The walk reaches `FixtureStampAlias` only after the property name is
    // gone, so before ISS-6208 neither side collected the key at all — and a
    // derived table that omits it agrees with a checked-in table that omits it
    // too, which is a guard that cannot fail.
    const discovered = discoverFixtureSources(
      `type FixtureStampAlias = string;
       type FixturePayload = { aliasedStringFixtureAt: FixtureStampAlias };`
    );

    expect([...discovered.stringKeys]).toContain("aliasedStringFixtureAt");
    expect([...discovered.keys]).not.toContain("aliasedStringFixtureAt");
  });

  it("carries the owning key through a nullable `Date` type alias", () => {
    const discovered = discoverFixtureSources(
      `type FixtureMomentAlias = Date;
       type FixturePayload = { aliasedDateFixtureAt: FixtureMomentAlias | null };`
    );

    expect([...discovered.keys]).toContain("aliasedDateFixtureAt");
  });

  it("carries the owning key through a chain of `string` aliases", () => {
    const discovered = discoverFixtureSources(
      `type FixtureInnerAlias = string;
       type FixtureOuterAlias = FixtureInnerAlias;
       type FixturePayload = { chainedStringFixtureAt: FixtureOuterAlias };`
    );

    expect([...discovered.stringKeys]).toContain("chainedStringFixtureAt");
  });

  it("carries the owning key through a reusable Zod string schema", () => {
    const discovered = discoverFixtureSources(
      `export const FixtureStampSchema = z.string();
       export const FixtureSchema = z.object({ schemaStringFixtureAt: FixtureStampSchema.optional() });
       type FixturePayload = z.infer<typeof FixtureSchema>;`
    );

    expect([...discovered.stringKeys]).toContain("schemaStringFixtureAt");
    expect([...discovered.keys]).not.toContain("schemaStringFixtureAt");
  });

  it("carries the owning key through a reusable Zod date schema", () => {
    const discovered = discoverFixtureSources(
      `export const FixtureMomentSchema = z.coerce.date();
       export const FixtureSchema = z.object({ schemaDateFixtureAt: FixtureMomentSchema });
       type FixturePayload = z.infer<typeof FixtureSchema>;`
    );

    expect([...discovered.keys]).toContain("schemaDateFixtureAt");
  });

  it("does not attribute an object's inner scalar to the property holding it", () => {
    // The other direction of the same fix, and what stops it from turning into
    // blanket suppression: `nestedFixtureHolder` is an object, not a timestamp,
    // and classifying it `string` would suppress revival on a key no endpoint
    // ever served as a scalar. Only the inner property is a `string` key.
    const discovered = discoverFixtureSources(
      `type FixtureNested = { innerStringFixtureAt: string };
       type FixturePayload = { nestedFixtureHolder: FixtureNested };`
    );

    expect([...discovered.stringKeys]).toContain("innerStringFixtureAt");
    expect([...discovered.stringKeys]).not.toContain("nestedFixtureHolder");
    expect([...discovered.keys]).not.toContain("nestedFixtureHolder");
  });

  it("does not attribute a Zod object schema's inner date to its holder", () => {
    const discovered = discoverFixtureSources(
      `export const FixtureNestedSchema = z.object({ innerDateFixtureAt: z.coerce.date() });
       export const FixtureSchema = z.object({ holderFixtureField: FixtureNestedSchema });
       type FixturePayload = z.infer<typeof FixtureSchema>;`
    );

    expect([...discovered.keys]).toContain("innerDateFixtureAt");
    expect([...discovered.stringKeys]).not.toContain("holderFixtureField");
  });
});
