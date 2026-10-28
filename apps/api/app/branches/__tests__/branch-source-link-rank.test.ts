import { LinkType } from "@repo/api/src/types/artifact";
import { describe, expect, it, vi } from "vitest";
import { writeBranchSourceLink } from "../branch-source-link";

vi.mock(
  "@/app/agent-sessions/service/attribution/derive-implementation-evidence",
  () => ({ deriveImplementationEvidence: vi.fn() })
);

describe("branch source PRODUCES order", () => {
  it("appends a new branch link after the parent's existing children", async () => {
    const aggregate = vi.fn().mockResolvedValue({ _max: { sortOrder: 2000 } });
    const upsert = vi.fn().mockResolvedValue({ id: "link-1" });
    const executeRaw = vi.fn().mockResolvedValue(1);
    const result = await writeBranchSourceLink(
      {
        $executeRaw: executeRaw,
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ projectId: "project-1" }),
        },
        artifactLink: { aggregate, upsert },
      } as never,
      {
        organizationId: "org-1",
        sourceArtifactId: "source-1",
        branchArtifactId: "branch-1",
      }
    );

    expect(aggregate).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        sourceId: "source-1",
        linkType: LinkType.Produces,
      },
      _max: { sortOrder: true },
    });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ sortOrder: 3000 }),
      })
    );
    expect(result).toEqual([
      { sourceArtifactId: "source-1", linkId: "link-1" },
    ]);
  });
});
