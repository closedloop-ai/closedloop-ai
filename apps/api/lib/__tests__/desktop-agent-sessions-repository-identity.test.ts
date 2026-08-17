import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";
import { validDesktopAgentSessionsPayload as validPayload } from "./desktop-agent-sessions-handler-fixtures";

/**
 * ISS-4996: the MALFORMED repository class is closed at the writer boundary.
 *
 * `nullableTrimmedStringSchema` nulls empty and whitespace-only values but
 * PRESERVES slash-only ones ("/", "//"), so a degenerate remote persisted as a
 * stored value carrying no identity — the one case the Sessions cell still has
 * to label "Unknown" rather than treat as absent. Normalizing here turns
 * "malformed is measured-zero" into "malformed is impossible" for every
 * producer, rather than leaving a latent unfilterable label that reappears the
 * first time a degenerate value lands.
 *
 * These parse the real entry point and assert the parsed value, rather than
 * asserting the schema was called — the shape that actually reaches the sink is
 * the contract.
 */

function parseWithRepositoryFullName(repositoryFullName: string | null) {
  const result = parseDesktopAgentSessionsPayload({
    ...validPayload,
    sessions: [
      {
        ...validPayload.sessions[0],
        attribution: {
          ...validPayload.sessions[0].attribution,
          repositoryFullName,
        },
      },
    ],
  });

  if (!result.ok) {
    throw new Error(`payload rejected: ${result.reason}`);
  }
  return result.payload.sessions[0]?.attribution?.repositoryFullName ?? null;
}

describe("synced session attribution — repository identity (ISS-4996)", () => {
  it.each([
    ["filesystem root", "/"],
    ["repeated slashes", "//"],
    ["slashes and whitespace", "  / "],
    ["empty string", ""],
    ["whitespace only", "   "],
  ])("nulls a %s repositoryFullName on ingest", (_label, value) => {
    expect(parseWithRepositoryFullName(value)).toBeNull();
  });

  it("preserves a well-formed remote verbatim", () => {
    expect(parseWithRepositoryFullName("closedloop-ai/symphony-alpha")).toBe(
      "closedloop-ai/symphony-alpha"
    );
  });

  it("trims a valid remote rather than rejecting it", () => {
    expect(parseWithRepositoryFullName("  acme/app  ")).toBe("acme/app");
  });

  it.each([
    ["a local-path remote", "my projects/repo"],
    ["a gitolite remote", "~user/repo"],
    ["a non-ASCII self-hosted owner", "Grüne/repo"],
    ["a single-segment name", "symphony-alpha"],
  ])("keeps %s — the normalizer is permissive by design, not an owner/repo guard", (_label, value) => {
    // Two different reasons live in this table, so keep them apart.
    //
    // The three OWNER/REPO rows are values the producer really can emit:
    // `resolveRepoFullName` — `git-helpers.ts` in the desktop gateway's
    // privileged operations tree — captures the one-slash tail of ANY origin
    // remote, so a local-path, gitolite, or non-ASCII owner resolves for real
    // users. Nulling them here would erase a repository that genuinely resolved
    // and desync the stored value from the Repository facet.
    //
    // The SINGLE-SEGMENT row is not one of those: that resolver's match
    // requires an owner/repo slash, so it can never produce a slashless name.
    // It is here because this schema is a permissive pass-through, not an
    // owner/repo guard — it must not invent a rejection rule the producer does
    // not enforce, and must not silently null a value some other or older
    // writer already stored.
    expect(parseWithRepositoryFullName(value)).toBe(value);
  });

  it("still accepts an absent repositoryFullName", () => {
    expect(parseWithRepositoryFullName(null)).toBeNull();
  });
});
