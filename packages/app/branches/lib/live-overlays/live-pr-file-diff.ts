import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { LivePrOverlayError } from "./live-pr-overlay-error";
import { branchesOverlayKeys } from "./overlay-keys";
import type { PrIdentity } from "./pr-identity";

export type LivePrFileDiffIdentity = PrIdentity & {
  branchId?: string;
  path: string;
  previousPath?: string;
};

const fileDiffEnvelopeSchema = z.object({
  path: z.string(),
  oldContent: z.string(),
  newContent: z.string(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
  isBinary: z.boolean(),
});

const errorEnvelopeSchema = z.object({ error: z.string() }).partial();

/** Query options for a live desktop PR file diff keyed by PR identity and path. */
export function livePrFileDiffOptions(identity: LivePrFileDiffIdentity | null) {
  return queryOptions<BranchViewFileDiff>({
    queryKey: branchesOverlayKeys.fileDiff(
      identity?.owner,
      identity?.repo,
      identity?.prNumber,
      identity?.branchId,
      identity?.path,
      identity?.previousPath
    ),
    enabled: Boolean(
      identity?.owner && identity?.repo && identity?.prNumber && identity?.path
    ),
    staleTime: 30_000,
    queryFn: async () => {
      if (!identity) {
        throw new LivePrOverlayError("missing file diff identity", {
          code: "no-identity",
          status: 0,
        });
      }
      const params = new URLSearchParams({
        owner: identity.owner,
        repo: identity.repo,
        number: String(identity.prNumber),
        path: identity.path,
      });
      if (identity.branchId) {
        params.set("branchId", identity.branchId);
      }
      if (identity.previousPath) {
        params.set("previousPath", identity.previousPath);
      }

      const response = await fetch(
        `/api/gateway/git/pr/file-diff?${params.toString()}`
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        throw new LivePrOverlayError(code, {
          code,
          status: response.status,
        });
      }
      return fileDiffEnvelopeSchema.parse(await response.json());
    },
  });
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json());
    if (parsed.success && parsed.data.error) {
      return parsed.data.error;
    }
  } catch {
    // Non-JSON error body falls through to the synthetic code.
  }
  return `pr-file-diff-${response.status}`;
}
