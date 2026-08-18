import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { LoopRequestBody } from "@closedloop-ai/loops-api/desktop-request";
import { describe, expect, test } from "vitest";
import type { LoopBody } from "./loop-body";

/**
 * ISS-5154 (review on #4447). `LoopBody` used to be a second, independent
 * declaration of the cloud→Desktop loop wire contract, and that split is how
 * `s3StateKey` and `branchMaterialization` reached the producer and the runtime
 * without ever reaching the type the Desktop gateway parses with.
 *
 * These assertions are the reason that cannot happen again: they fail at
 * COMPILE time, so a producer-only field is a `tsc` error at the point of
 * drift rather than a defect discovered on a Desktop build months later.
 */

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

describe("LoopBody derives from the canonical wire contract", () => {
  test("declares exactly the canonical contract's fields, no more", () => {
    // Re-declaring LoopBody with a producer-only field — the s3StateKey
    // mistake — makes these key sets diverge and fails the build.
    const coversContract: Expect<
      Equals<keyof LoopBody, keyof LoopRequestBody>
    > = true;

    expect(coversContract).toBe(true);
  });

  test("rejects a dispatched body carrying a field the contract never declared", () => {
    const base: LoopBody = {
      loopId: "loop-1",
      command: LoopCommand.Execute,
      closedLoopAuthToken: "token",
      apiBaseUrl: "https://api.example.com",
      artifacts: [],
      prompt: null,
      repo: null,
      committer: null,
      artifactSlug: null,
      parentLoopId: null,
      parentBranchName: null,
      parentSessionId: null,
      localRepoPath: null,
    };

    // This mirrors the `satisfies LoopBody` literal in
    // `buildDesktopLoopExecutionBody`. If it stops erroring, the producer can
    // once again grow a field the Desktop parser's type never learns about,
    // and the unused @ts-expect-error fails the build to say so.
    const drifted = {
      ...base,
      // @ts-expect-error - absent from LoopRequestBody, so absent from LoopBody
      fieldOnlyTheProducerKnows: "value",
    } satisfies LoopBody;

    expect(drifted.loopId).toBe("loop-1");
  });

  test("keeps the dispatcher's null-instead-of-omitted projection", () => {
    // The dispatcher sends these as explicit nulls while Desktop tolerates
    // their absence. That difference is declared once, in the derivation, and
    // is the only respect in which the two sides' views differ.
    const nullable: Pick<LoopBody, "prompt" | "repo"> = {
      prompt: null,
      repo: null,
    };

    expect(nullable.prompt).toBeNull();
    expect(nullable.repo).toBeNull();
  });
});
