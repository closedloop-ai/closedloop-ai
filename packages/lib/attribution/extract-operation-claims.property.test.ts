/**
 * ISS-12552: the claim extractor's requirements as
 * properties (AC-025): replay idempotence, order independence for calls with
 * their own ids, unrelated-reference insertion, read-after-write
 * preservation, pagination equivalence, and alias stability.
 */
import {
  type OperationClaim,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createNormalizedSession,
  Harness,
  type NormalizedToolUse,
} from "../harness/types";
import { extractOperationClaims } from "./extract-operation-claims";

const TS = "2026-10-16T12:00:00.000Z";
const TARGETED_TOOLS = [
  "get-document",
  "get-document-content",
  "list-document-versions",
  "update-document",
  "create-document-version",
] as const;
const PAGED_TOOLS = ["search", "list-documents"] as const;

const slug = fc
  .tuple(
    fc.constantFrom("PLN", "PRD", "ISS"),
    fc.integer({ min: 1, max: 9999 })
  )
  .map(([prefix, number]) => `${prefix}-${number}`);
const target = fc.oneof(fc.uuid(), slug);

const call = fc.record({
  tool: fc.constantFrom(...TARGETED_TOOLS, ...PAGED_TOOLS),
  target,
  nestedSlugs: fc.uniqueArray(slug, { maxLength: 4 }),
});

/** Calls with distinct ids, as a harness assigns them. */
const calls = fc
  .array(call, { maxLength: 12 })
  .map((drafts) =>
    drafts.map((draft, index) => toolUse(`toolu_${index}`, draft))
  );

function toolUse(
  id: string,
  draft: { tool: string; target: string; nestedSlugs: string[] }
): NormalizedToolUse {
  const targeted = (TARGETED_TOOLS as readonly string[]).includes(draft.tool);
  return {
    name: `mcp__closedloop__${draft.tool}`,
    id,
    timestamp: TS,
    resultTimestamp: TS,
    input: targeted ? { documentId: draft.target } : { query: "plans" },
    output: "{}",
    resultState: ToolResultState.Present,
    closedloopResultFacts: { isError: false, nestedSlugs: draft.nestedSlugs },
  };
}

function prose(id: string, text: string): NormalizedToolUse {
  return {
    name: "Bash",
    id,
    timestamp: TS,
    resultTimestamp: TS,
    input: { command: `echo ${text}` },
    output: text,
    resultState: ToolResultState.Present,
  };
}

async function claimsOf(
  toolUses: NormalizedToolUse[]
): Promise<OperationClaim[]> {
  const { claims } = await extractOperationClaims(
    createNormalizedSession({
      sessionId: "properties",
      version: "2.1.296",
      toolUses,
    }),
    Harness.Claude
  );
  return claims;
}

function byKey(claims: readonly OperationClaim[]): OperationClaim[] {
  return [...claims].sort((left, right) =>
    left.claimKey < right.claimKey ? -1 : 1
  );
}

function referencedSlugs(claims: readonly OperationClaim[]): string[] {
  return [
    ...new Set(claims.flatMap((claim) => claim.nestedReferenceSlugs ?? [])),
  ].sort();
}

describe("extractOperationClaims properties", () => {
  it("replays a transcript to the same claims", async () => {
    await fc.assert(
      fc.asyncProperty(calls, async (toolUses) => {
        expect(await claimsOf(toolUses)).toEqual(await claimsOf(toolUses));
      })
    );
  });

  it("does not depend on the order of calls that carry their own ids", async () => {
    await fc.assert(
      fc.asyncProperty(calls, async (toolUses) => {
        expect(byKey(await claimsOf([...toolUses].reverse()))).toEqual(
          byKey(await claimsOf(toolUses))
        );
      })
    );
  });

  it("adds at most a reference claim when an unrelated slug is mentioned", async () => {
    await fc.assert(
      fc.asyncProperty(calls, async (toolUses) => {
        const before = await claimsOf(toolUses);
        const after = await claimsOf([
          ...toolUses,
          prose("toolu_unrelated", "see WRK-424242"),
        ]);
        expect(
          after.filter((claim) => claim.referenceSlug !== "WRK-424242")
        ).toEqual(before);
        expect(
          after.filter((claim) => claim.referenceSlug === "WRK-424242")
        ).toHaveLength(1);
      })
    );
  });

  it("keeps a write's claim unchanged when the artifact is read afterwards", async () => {
    await fc.assert(
      fc.asyncProperty(calls, target, async (toolUses, written) => {
        const write = toolUse("toolu_write", {
          tool: "update-document",
          target: written,
          nestedSlugs: [],
        });
        const read = toolUse("toolu_read_after", {
          tool: "get-document",
          target: written,
          nestedSlugs: [],
        });
        const writeClaim = (claims: OperationClaim[]) =>
          claims.find((claim) => claim.providerCallId === "toolu_write");
        const alone = writeClaim(await claimsOf([...toolUses, write]));
        expect(alone).toBeDefined();
        expect(writeClaim(await claimsOf([...toolUses, write, read]))).toEqual(
          alone
        );
      })
    );
  });

  it("names the same artifacts whether a result arrives in one page or several", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PAGED_TOOLS),
        fc.uniqueArray(slug, { minLength: 1, maxLength: 12 }),
        fc.nat(),
        async (tool, slugs, cut) => {
          const split = cut % (slugs.length + 1);
          const onePage = await claimsOf([
            toolUse("toolu_page", { tool, target: "", nestedSlugs: slugs }),
          ]);
          const twoPages = await claimsOf([
            toolUse("toolu_page_1", {
              tool,
              target: "",
              nestedSlugs: slugs.slice(0, split),
            }),
            toolUse("toolu_page_2", {
              tool,
              target: "",
              nestedSlugs: slugs.slice(split),
            }),
          ]);
          expect(referencedSlugs(onePage)).toEqual([...slugs].sort());
          expect(referencedSlugs(twoPages)).toEqual(referencedSlugs(onePage));
        }
      )
    );
  });

  it("names one target for every spelling of one slug or UUID", async () => {
    const spelling = (value: string) =>
      fc
        .tuple(
          fc.array(fc.boolean(), {
            minLength: value.length,
            maxLength: value.length,
          }),
          fc.constantFrom("", " ", "  "),
          fc.constantFrom("", " ", "\t")
        )
        .map(
          ([upper, before, after]) =>
            `${before}${[...value]
              .map((char, index) =>
                upper[index] ? char.toUpperCase() : char.toLowerCase()
              )
              .join("")}${after}`
        );
    await fc.assert(
      fc.asyncProperty(
        target.chain((value) => fc.tuple(fc.constant(value), spelling(value))),
        async ([canonical, variant]) => {
          const targetsOf = async (value: string) =>
            (
              await claimsOf([
                toolUse("toolu_alias", {
                  tool: "get-document",
                  target: value,
                  nestedSlugs: [],
                }),
              ])
            )[0]?.inputTargets;
          const canonicalTargets = await targetsOf(canonical);
          expect(canonicalTargets).toHaveLength(1);
          expect(await targetsOf(variant)).toEqual(canonicalTargets);
        }
      )
    );
  });
});
