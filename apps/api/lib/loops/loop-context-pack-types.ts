/**
 * Shared input types for context-pack assembly.
 *
 * Split out of loop-context-pack.ts so sibling enrichment modules (e.g.
 * loop-context-pack-evergreen-docs.ts) can consume `LoopForContextPack` without
 * importing the assembly module and creating a cycle.
 */

import type { ArtifactType } from "@repo/api/src/types/artifact";
import type { LoopCommand } from "@repo/api/src/types/loop";

export type LoopForContextPack = {
  id: string;
  userId: string;
  command: LoopCommand;
  prompt: string | null;
  documentId: string | null;
  documentVersion: number | null;
  parentLoopId: string | null;
  repo: { fullName: string; branch: string } | null;
  metadata?: Record<string, unknown> | null;
  contextRefs: Array<{
    sourceId: string;
    sourceType?: ArtifactType;
    include: "full" | "summary";
  }> | null;
};
