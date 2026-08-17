import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { LoopArtifactType } from "./artifacts";
import { LoopCommand } from "./commands";
import {
  LoopBranchMaterializationRole,
  LoopHarness,
  type LoopRequestBody,
  LoopRequestBodySchema,
} from "./desktop-request";

/**
 * ISS-5154 (review on #4447). `LoopRequestBody` is the single declaration of
 * the cloud→Desktop loop wire contract; `LoopBody` in packages/api is derived
 * from it. These cover the two halves of that guarantee: the schema cannot
 * drift away from the type (compile time), and the parse boundary keeps
 * tolerating older and newer peers (runtime).
 */

type LoopRequestBodySchemaShape = Record<keyof LoopRequestBody, z.ZodTypeAny>;

const validBody: LoopRequestBody = {
  loopId: "loop-1",
  command: LoopCommand.Execute,
  closedLoopAuthToken: "token",
  apiBaseUrl: "https://api.example.com",
  artifacts: [
    {
      id: "artifact-1",
      type: LoopArtifactType.ImplementationPlan,
      title: "Plan",
      content: "{}",
    },
  ],
};

describe("LoopRequestBodySchema drift guard", () => {
  test("a shape missing a contract field does not satisfy the coverage guard", () => {
    // If this stops erroring, `LoopRequestBodySchema`'s
    // `satisfies Record<keyof LoopRequestBody, z.ZodTypeAny>` has stopped being
    // total over the contract, and the next field added to `LoopRequestBody`
    // would parse as an unknown key and be silently stripped. The directive
    // below then goes unused and fails the build, which is the point.
    // @ts-expect-error - omits every contract field except loopId
    const incomplete: LoopRequestBodySchemaShape = {
      loopId: LoopRequestBodySchema.shape.loopId,
    };
    expect(incomplete).toBeDefined();
  });

  test("a shape key the contract does not declare does not satisfy the guard", () => {
    const withUnknownKey: LoopRequestBodySchemaShape = {
      ...LoopRequestBodySchema.shape,
      // @ts-expect-error - a schema key absent from LoopRequestBody
      fieldTheContractNeverDeclared: LoopRequestBodySchema.shape.loopId,
    };
    expect(withUnknownKey).toBeDefined();
  });
});

describe("LoopRequestBodySchema parsing", () => {
  test("preserves the fields that previously reached only the producer", () => {
    const parsed = LoopRequestBodySchema.parse({
      ...validBody,
      s3StateKey: "org-1/loops/loop-1/run-1",
      branchMaterialization: {
        schemaVersion: 1,
        branches: [
          {
            role: LoopBranchMaterializationRole.Primary,
            repositoryFullName: "closedloop-ai/symphony-alpha",
            baseBranch: "main",
            branchName: "feat/x",
          },
        ],
      },
      harness: LoopHarness.Codex,
    });

    expect(parsed.s3StateKey).toBe("org-1/loops/loop-1/run-1");
    expect(parsed.branchMaterialization?.branches[0]?.branchName).toBe(
      "feat/x"
    );
    expect(parsed.harness).toBe(LoopHarness.Codex);
  });

  test("an older dispatcher's body parses and keeps the new fields absent", () => {
    const parsed = LoopRequestBodySchema.parse({ ...validBody });

    expect(parsed.loopId).toBe("loop-1");
    // Omission is preserved rather than materialized as null, so a re-serialized
    // body stays byte-compatible with an older Desktop build.
    expect("s3StateKey" in parsed).toBe(false);
    expect("branchMaterialization" in parsed).toBe(false);
  });

  test("a newer dispatcher's unknown field degrades instead of throwing", () => {
    const parsed = LoopRequestBodySchema.parse({
      ...validBody,
      fieldFromANewerDispatcher: "ignored",
    });

    expect(parsed.loopId).toBe("loop-1");
    expect("fieldFromANewerDispatcher" in parsed).toBe(false);
  });
});
