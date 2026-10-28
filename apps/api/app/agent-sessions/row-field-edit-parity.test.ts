/**
 * ISS-9485 — the writable-field sets in `@repo/api/src/types/artifact-row-field-edit`
 * are what the editor registry (ISS-9484) reads; the validators are what the
 * PATCH routes enforce. Pinned to each other in both directions, at runtime
 * and at `tsc`, so a body field added without a registry entry — or an entry
 * with no body field behind it — fails here rather than in a grid that offers
 * an edit the route refuses.
 */
import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import {
  AGENT_SESSION_ROW_FIELD_EDIT,
  AgentSessionPatchField,
  BRANCH_ROW_FIELD_EDIT,
  BranchPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
import { describe, expect, expectTypeOf, it } from "vitest";
import { updateBranchPriorityBodySchema } from "@/app/branches/branch-priority-validators";
import { agentSessionUpdateBodySchema } from "./validators";
import type { AgentSessionUpdateRequest } from "./write-contract";

/** Body keys that ride WITH a field write and never write a row field. */
type CompanionKey = "expectedPriority" | "surface";
const COMPANION_KEYS: readonly CompanionKey[] = ["expectedPriority", "surface"];

/** ISS-9486: the Session PATCH's per-field guards are companions too. */
type SessionCompanionKey =
  | CompanionKey
  | "expectedName"
  | "expectedStatus"
  | "expectedProjectId"
  | "expectedOwnerUserId";
const SESSION_COMPANION_KEYS: readonly SessionCompanionKey[] = [
  ...COMPANION_KEYS,
  "expectedName",
  "expectedStatus",
  "expectedProjectId",
  "expectedOwnerUserId",
];

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe("row-field registry ↔ PATCH validator parity (ISS-9485)", () => {
  it("Sessions: the body writes exactly the patch fields, plus companions", () => {
    expectTypeOf<AgentSessionPatchField>().toEqualTypeOf<
      Exclude<keyof AgentSessionUpdateRequest, SessionCompanionKey>
    >();
    expect(sorted(Object.keys(agentSessionUpdateBodySchema.shape))).toEqual(
      sorted([
        ...Object.values(AgentSessionPatchField),
        ...SESSION_COMPANION_KEYS,
      ])
    );
  });

  it("Branches: the body writes exactly the patch fields, plus companions", () => {
    expectTypeOf<BranchPatchField>().toEqualTypeOf<
      Exclude<keyof UpdateArtifactPriorityRequest, CompanionKey>
    >();
    expect(sorted(Object.keys(updateBranchPriorityBodySchema.shape))).toEqual(
      sorted([...Object.values(BranchPatchField), ...COMPANION_KEYS])
    );
  });

  it("every patch field is written from some row field", () => {
    const sessionTargets = new Set<string>(
      Object.values(AGENT_SESSION_ROW_FIELD_EDIT)
    );
    const branchTargets = new Set<string>(Object.values(BRANCH_ROW_FIELD_EDIT));
    for (const field of Object.values(AgentSessionPatchField)) {
      expect(sessionTargets.has(field), field).toBe(true);
    }
    for (const field of Object.values(BranchPatchField)) {
      expect(branchTargets.has(field), field).toBe(true);
    }
  });
});
