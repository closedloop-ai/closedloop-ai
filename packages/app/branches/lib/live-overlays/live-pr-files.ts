/**
 * Live files-changed read (Epic F / FEA-1952 — F1).
 *
 * Consumes the `GET /api/gateway/git/pr/files?owner=&repo=&number=` route
 * (returns `{ files: [{ filename, additions, deletions, status?,
 * previous_filename? }] }` — per-file LOC from the PR's own GitHub data) via
 * `window.fetch` → the engineer fetch interceptor.
 * The result is held ONLY in the React Query overlay cache and is NEVER
 * persisted: `BranchRow.filesChanged`/`additions`/`deletions` from the
 * data-source port stay `null`.
 *
 * These PR-sourced totals are authoritative LOC and should be PREFERRED over
 * enrichment-derived `BranchPageDetail.additions`/`deletions` wherever both are
 * available (see `branch-files-changed-panel.tsx`).
 *
 * Mirrors the established `apps/app/lib/engineer/queries/*` factory shape
 * (`queryOptions` + `window.fetch` + `!response.ok` guard).
 */

import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { LivePrOverlayError } from "./live-pr-overlay-error";
import { branchesOverlayKeys } from "./overlay-keys";
import type { PrIdentity } from "./pr-identity";

/** Files are fetched slug-only (owner/repo/PR), like the status overlay — no
 * local checkout required, so any PR the authed `gh` user can read resolves. */
export type LivePrFilesIdentity = PrIdentity;

/** One changed file with its PR-sourced additions/deletions. */
export type LivePrFile = {
  path: string;
  previousPath?: string;
  status?: string;
  additions: number;
  deletions: number;
};

export type LivePrFilesResult = {
  files: readonly LivePrFile[];
  filesChanged: number;
  /** Totals across all files (sum of per-file LOC). Authoritative (from the PR). */
  additions: number;
  deletions: number;
  source: "github";
};

const fileEntrySchema = z.object({
  filename: z.string(),
  additions: z.number(),
  deletions: z.number(),
  status: z.string().optional(),
  previous_filename: z.string().optional(),
});
const filesEnvelopeSchema = z.object({ files: z.array(fileEntrySchema) });
const errorEnvelopeSchema = z.object({ error: z.string() }).partial();

async function readErrorCode(response: Response): Promise<string> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await response.json());
    if (parsed.success && parsed.data.error) {
      return parsed.data.error;
    }
  } catch {
    // Non-JSON error body — fall through to the synthetic code.
  }
  return `pr-files-${response.status}`;
}

export function livePrFilesOptions(identity: LivePrFilesIdentity | null) {
  return queryOptions<LivePrFilesResult>({
    queryKey: branchesOverlayKeys.files(
      identity?.owner,
      identity?.repo,
      identity?.prNumber
    ),
    enabled: Boolean(identity?.owner && identity?.repo && identity?.prNumber),
    staleTime: 30_000,
    // No keepPreviousData: it would surface the PREVIOUS branch's files on a new
    // branch whose key differs or whose query is disabled (stale cross-branch
    // data). On a same-key F5 refetch the cached data already persists, so the
    // panel still never blanks.
    queryFn: async () => {
      if (!identity) {
        // Unreachable while `enabled` gates the query, but keeps the queryFn
        // total and the identity non-null below.
        throw new LivePrOverlayError("missing files identity", {
          code: "no-identity",
          status: 0,
        });
      }
      const response = await fetch(
        `/api/gateway/git/pr/files?owner=${encodeURIComponent(
          identity.owner
        )}&repo=${encodeURIComponent(identity.repo)}&number=${identity.prNumber}`
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        throw new LivePrOverlayError(code, {
          code,
          status: response.status,
        });
      }
      const { files } = filesEnvelopeSchema.parse(await response.json());
      const mapped = files.map((file) => ({
        path: file.filename,
        previousPath: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      }));
      const additions = mapped.reduce((sum, file) => sum + file.additions, 0);
      const deletions = mapped.reduce((sum, file) => sum + file.deletions, 0);
      return {
        files: mapped,
        filesChanged: mapped.length,
        additions,
        deletions,
        source: "github",
      } as const;
    },
  });
}
