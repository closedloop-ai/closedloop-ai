import { z } from "zod";
import type { LoopCommand } from "./commands";
import { LoopCommandSchema } from "./commands";

import type { ContextPackAttachment } from "./context-pack";
import { ContextPackAttachmentSchema } from "./context-pack";

/**
 * Request body sent from the backend API to the desktop gateway (Electron)
 * via the relay WebSocket. This is a flattened version of context pack +
 * loop metadata — NOT the same shape as ContextPack (S3 transport).
 *
 * Canonical source: closedloop-electron/apps/desktop/src/server/operations/symphony-loop.ts
 */
export type LoopRequestBody = {
  loopId: string;
  command: LoopCommand;
  closedLoopAuthToken: string;
  apiBaseUrl?: string;
  artifacts: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
  }>;
  repo?: { fullName: string; branch: string };
  committer?: { name: string; email: string };
  artifactSlug?: string;
  parentLoopId?: string;
  parentBranchName?: string;
  parentSessionId?: string;
  prompt?: string;
  localRepoPath?: string;
  userContext?: string;
  attachments?: ContextPackAttachment[];
};

export const LoopRequestBodySchema = z.object({
  loopId: z.string(),
  command: LoopCommandSchema,
  closedLoopAuthToken: z.string(),
  apiBaseUrl: z.string().optional(),
  artifacts: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      content: z.string(),
    })
  ),
  repo: z
    .object({
      fullName: z.string(),
      branch: z.string(),
    })
    .optional(),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
    })
    .optional(),
  artifactSlug: z.string().optional(),
  parentLoopId: z.string().optional(),
  parentBranchName: z.string().optional(),
  parentSessionId: z.string().optional(),
  prompt: z.string().optional(),
  localRepoPath: z.string().optional(),
  userContext: z.string().optional(),
  attachments: z.array(ContextPackAttachmentSchema).optional(),
});
