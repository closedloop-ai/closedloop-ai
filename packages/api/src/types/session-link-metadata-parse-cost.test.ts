import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BranchParticipationKind } from "./branch.ts";
import {
  ArtifactRefRelation,
  parseSessionPrLinkMetadata,
} from "./session-artifact-link.ts";
import {
  classifySessionPrMetadata,
  SessionArtifactLinkKind,
  SessionPrMetadataClassificationKind,
} from "./session-pr-link-metadata.ts";

// ISS-11895: every session-link reader parses each link's metadata, over link
// populations in the tens of thousands per `/agent-sessions/usage` request. A
// `z.enum` built per value, or a failed enum `safeParse` (a `ZodError` with a
// captured stack) per absent field, costs tens of microseconds a link and was
// over half of that route's slow-request wall time. Counted, not timed.
const zodCalls = vi.hoisted(() => ({ enumsBuilt: 0, failedEnumParses: 0 }));

vi.mock("zod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zod")>();
  const countingEnum = ((...args: Parameters<typeof actual.z.enum>) => {
    zodCalls.enumsBuilt += 1;
    const schema = actual.z.enum(...args);
    const safeParse = schema.safeParse.bind(schema);
    schema.safeParse = (value, params) => {
      const result = safeParse(value, params);
      if (!result.success) {
        zodCalls.failedEnumParses += 1;
      }
      return result;
    };
    return schema;
  }) as typeof actual.z.enum;
  return { ...actual, z: { ...actual.z, enum: countingEnum } };
});

const enumsBuiltAtImport = zodCalls.enumsBuilt;

/** A session→PR link as the branch writer persists it: no `relation`, no `branchParticipation`. */
const persistedPrLinkMetadata = {
  linkKind: "session_pr",
  linkKinds: ["session_branch", "session_pr"],
  relationTypes: ["CREATED"],
  prRefs: [
    {
      repositoryFullName: "acme/web",
      prNumber: 42,
      relationTypes: ["CREATED"],
      method: "gh_pr_create",
    },
  ],
  confidence: 1,
  repositoryFullName: "acme/web",
  prNumber: 42,
};

describe("persisted session-link metadata parse cost (ISS-11895)", () => {
  beforeEach(() => {
    zodCalls.enumsBuilt = 0;
    zodCalls.failedEnumParses = 0;
  });

  it("counts enum builds and failed enum parses through the mocked zod", () => {
    expect(enumsBuiltAtImport).toBeGreaterThan(0);

    const probe = z.enum(["known"]).safeParse("unknown");

    expect(probe.success).toBe(false);
    expect(zodCalls).toEqual({ enumsBuilt: 1, failedEnumParses: 1 });
  });

  it("parses an ordinary persisted link without building a schema or failing an enum parse", () => {
    const parsed = parseSessionPrLinkMetadata(persistedPrLinkMetadata);
    const classification = classifySessionPrMetadata(persistedPrLinkMetadata);

    expect(parsed?.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionBranch,
      SessionArtifactLinkKind.SessionPr,
    ]);
    expect(parsed?.relation).toBeUndefined();
    expect(parsed?.branchParticipation).toBeUndefined();
    expect(classification.kind).toBe(
      SessionPrMetadataClassificationKind.Canonical
    );
    expect(zodCalls).toEqual({ enumsBuilt: 0, failedEnumParses: 0 });
  });

  it("keeps a stored relation and participation without failing an enum parse", () => {
    const parsed = parseSessionPrLinkMetadata({
      ...persistedPrLinkMetadata,
      relation: "output",
      branchParticipation: "wrote",
    });

    expect(parsed?.relation).toBe(ArtifactRefRelation.Output);
    expect(parsed?.branchParticipation).toBe(BranchParticipationKind.Wrote);
    expect(zodCalls).toEqual({ enumsBuilt: 0, failedEnumParses: 0 });
  });

  it("drops an unknown linkKinds member without failing an enum parse", () => {
    const classification = classifySessionPrMetadata({
      linkKinds: ["session_branch", "future_kind", "session_pr"],
    });
    const parsed = parseSessionPrLinkMetadata({
      linkKinds: ["session_branch", "future_kind", "session_pr"],
    });

    expect(classification.kind).toBe(SessionPrMetadataClassificationKind.None);
    expect(parsed?.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionBranch,
      SessionArtifactLinkKind.SessionPr,
    ]);
    expect(zodCalls).toEqual({ enumsBuilt: 0, failedEnumParses: 0 });
  });
});
