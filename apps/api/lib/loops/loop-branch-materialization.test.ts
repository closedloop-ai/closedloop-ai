import { LoopCommand } from "@repo/api/src/types/loop";
import { LoopBranchMaterializationRole } from "@repo/api/src/types/loop-body";
import { describe, expect, it } from "vitest";
import { buildLoopBranchMaterialization } from "./loop-branch-materialization";

const NORMALIZED_ADDITIONAL_BRANCH_REGEX =
  /^symphony\/loop-019e293c-b1be-7640-bfce-464d5732c114-closedloop-ai-sidecar-repo-with-spaces-[a-f0-9]{8}$/;

describe("buildLoopBranchMaterialization", () => {
  it("builds the exact primary and additional branch envelope", () => {
    const envelope = buildLoopBranchMaterialization({
      command: LoopCommand.Execute,
      loopId: "019e293c-b1be-7640-bfce-464d5732c114",
      documentSlug: "FEA-1132",
      primaryRepo: {
        fullName: "closedloop-ai/symphony-alpha",
        branch: "main",
      },
      additionalRepos: [
        { fullName: "closedloop-ai/sidecar", branch: "feature/base" },
      ],
    });

    expect(envelope).toEqual({
      schemaVersion: 1,
      branches: [
        {
          role: LoopBranchMaterializationRole.Primary,
          repositoryFullName: "closedloop-ai/symphony-alpha",
          baseBranch: "main",
          branchName: "symphony/fea-1132",
        },
        {
          role: LoopBranchMaterializationRole.Additional,
          repositoryFullName: "closedloop-ai/sidecar",
          baseBranch: "feature/base",
          branchName: "symphony/fea-1132-closedloop-ai-sidecar-99499e02",
        },
      ],
    });
  });

  it("returns null for GENERATE_PRD — fully read-only command", () => {
    expect(
      buildLoopBranchMaterialization({
        command: LoopCommand.GeneratePrd,
        loopId: "019e293c-b1be-7640-bfce-464d5732c114",
        documentSlug: "PRD-604",
        primaryRepo: { fullName: "closedloop-ai/symphony", branch: "main" },
        additionalRepos: [
          { fullName: "closedloop-ai/sidecar", branch: "main" },
        ],
      })
    ).toBeNull();
  });

  it("returns null for REQUEST_PRD_CHANGES — fully read-only command", () => {
    expect(
      buildLoopBranchMaterialization({
        command: LoopCommand.RequestPrdChanges,
        loopId: "019e293c-b1be-7640-bfce-464d5732c114",
        documentSlug: "PRD-604",
        primaryRepo: { fullName: "closedloop-ai/symphony", branch: "main" },
        additionalRepos: [
          { fullName: "closedloop-ai/sidecar", branch: "main" },
        ],
      })
    ).toBeNull();
  });

  it("falls back to the loop id when the document slug is absent", () => {
    const first = buildLoopBranchMaterialization({
      command: LoopCommand.Plan,
      loopId: "019e293c-b1be-7640-bfce-464d5732c114",
      documentSlug: " -- ",
      primaryRepo: { fullName: "closedloop-ai/symphony", branch: "main" },
    });
    const second = buildLoopBranchMaterialization({
      command: LoopCommand.Plan,
      loopId: "019e2aaa-b1be-7640-bfce-464d5732c114",
      documentSlug: null,
      primaryRepo: { fullName: "closedloop-ai/symphony", branch: "main" },
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.branches[0].branchName).toBe(
      "symphony/loop-019e293c-b1be-7640-bfce-464d5732c114"
    );
    expect(second!.branches[0].branchName).toBe(
      "symphony/loop-019e2aaa-b1be-7640-bfce-464d5732c114"
    );
    expect(first!.branches[0].branchName).not.toBe(
      second!.branches[0].branchName
    );
  });

  it("normalizes additional repository slug input for write-mode peers", () => {
    const envelope = buildLoopBranchMaterialization({
      command: LoopCommand.Execute,
      loopId: "019e293c-b1be-7640-bfce-464d5732c114",
      documentSlug: " -- ",
      primaryRepo: { fullName: "closedloop-ai/symphony", branch: "main" },
      additionalRepos: [
        {
          fullName: "Closedloop AI / Sidecar Repo With Spaces",
          branch: "release",
        },
      ],
    });

    expect(envelope).not.toBeNull();
    const branches = envelope!.branches;
    expect(branches[0].branchName).toBe(
      "symphony/loop-019e293c-b1be-7640-bfce-464d5732c114"
    );
    expect(branches[1].branchName).toMatch(NORMALIZED_ADDITIONAL_BRANCH_REGEX);
  });

  it("PLAN with peers includes only the primary entry — peers are read-only", () => {
    const envelope = buildLoopBranchMaterialization({
      command: LoopCommand.Plan,
      loopId: "019e293c-b1be-7640-bfce-464d5732c114",
      documentSlug: "PLN-797",
      primaryRepo: { fullName: "closedloop-ai/symphony-alpha", branch: "main" },
      additionalRepos: [
        { fullName: "closedloop-ai/closedloop-electron", branch: "main" },
      ],
    });

    expect(envelope).not.toBeNull();
    expect(envelope!.branches).toHaveLength(1);
    expect(envelope!.branches[0]).toEqual({
      role: LoopBranchMaterializationRole.Primary,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      baseBranch: "main",
      branchName: "symphony/pln-797",
    });
  });

  it("returns null for EVALUATE_PLAN — read-only evaluation command", () => {
    expect(
      buildLoopBranchMaterialization({
        command: LoopCommand.EvaluatePlan,
        loopId: "019e293c-b1be-7640-bfce-464d5732c114",
        documentSlug: "PLN-797",
        primaryRepo: { fullName: "closedloop-ai/symphony", branch: "main" },
      })
    ).toBeNull();
  });

  it("returns null for EVALUATE_CODE — read-only evaluation command", () => {
    expect(
      buildLoopBranchMaterialization({
        command: LoopCommand.EvaluateCode,
        loopId: "019e293c-b1be-7640-bfce-464d5732c114",
        documentSlug: "FEA-1474",
        primaryRepo: { fullName: "closedloop-ai/symphony", branch: "main" },
      })
    ).toBeNull();
  });

  it("EXECUTE without additional repos produces an envelope with only the primary entry", () => {
    const envelope = buildLoopBranchMaterialization({
      command: LoopCommand.Execute,
      loopId: "019e293c-b1be-7640-bfce-464d5732c114",
      documentSlug: "FEA-1474",
      primaryRepo: { fullName: "closedloop-ai/symphony-alpha", branch: "main" },
    });

    expect(envelope).not.toBeNull();
    expect(envelope!.branches).toHaveLength(1);
    expect(envelope!.branches[0].role).toBe(
      LoopBranchMaterializationRole.Primary
    );
    expect(envelope!.branches[0].branchName).toBe("symphony/fea-1474");
  });
});
