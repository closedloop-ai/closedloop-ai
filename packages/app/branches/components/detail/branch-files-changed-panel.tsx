"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { FileIcon, GitBranchIcon, HardDriveIcon } from "lucide-react";
import {
  type LivePrFile,
  livePrFilesOptions,
} from "../../lib/live-overlays/live-pr-files";
import { derivePrIdentity } from "../../lib/live-overlays/pr-identity";
import { ConnectGitHubIndicator } from "../connect-github-indicator";

/**
 * F1 — live files-changed panel (Epic F / FEA-1952).
 *
 * Renders the PR's changed-file list fetched LIVE from the GitHub gateway
 * (`/pr/files`) — with per-file additions/deletions from the PR's own data,
 * never persisted. Identity is the owner/repo slug + PR number (like the F2
 * status overlay), so files resolve for any PR the authed `gh` user can read,
 * with NO local clone/registration required. The result lives only in the React
 * Query overlay cache; `BranchPageDetail.filesChanged`/`additions`/`deletions`
 * from the port stay `null` and are never read as numbers here.
 *
 * LOC preference: when a PR is connected, the panel shows the PR-sourced totals
 * (authoritative — "GitHub" source). The enrichment-derived `DerivedLoc`
 * fallback ("Local filesystem") is shown ONLY in degraded states (no PR / multi
 * PR / unavailable), so PR numbers always win when available.
 *
 * Degrades honestly per state (never a thrown error): a branch with no PR shows
 * "changed files appear once a pull request is opened" (the common case — there
 * is no per-file source for a branch without a connected PR in v1); multiple
 * linked PRs gate on ambiguity; a single linked PR whose files can't be fetched
 * (GitHub not connected/authed) shows a connect-GitHub affordance.
 */

export type BranchFilesChangedPanelProps = {
  detail: BranchPageDetail;
};

/**
 * Source-of-truth indicator for a changes measure. Exported so the same chip can
 * mark the derived-LOC fallback wherever it appears (e.g. a list "Changes" cell).
 */
export function SourceIndicatorChip({
  source,
}: {
  source: "github" | "local";
}) {
  const isGithub = source === "github";
  return (
    <Chip size="sm" variant={isGithub ? "accent" : "muted"}>
      {isGithub ? <GitBranchIcon aria-hidden /> : <HardDriveIcon aria-hidden />}
      {isGithub ? "GitHub" : "Local filesystem"}
    </Chip>
  );
}

/**
 * Presentational net-LOC: `+adds −dels`. `withLabel` appends " changed" for the
 * summary line; per-file rows omit it to stay compact.
 */
function NetLoc({
  additions,
  deletions,
  withLabel = false,
}: {
  additions: number;
  deletions: number;
  withLabel?: boolean;
}) {
  return (
    <span className="text-xs">
      <b className="font-semibold text-success">{`+${formatNumber(additions)}`}</b>{" "}
      <b className="font-semibold text-destructive">{`−${formatNumber(deletions)}`}</b>
      {withLabel ? (
        <span className="text-muted-foreground"> changed</span>
      ) : null}
    </span>
  );
}

/**
 * The enrichment-derived net-LOC line ("Local filesystem" source), shown ONLY in
 * degraded states and ONLY when the enrichment columns are populated — PR-sourced
 * totals are preferred whenever a PR is connected. NULL means "unavailable", not
 * 0 (branch.ts); with only one side populated, "+10 −0" would fabricate the
 * other, so we require both.
 */
function DerivedLoc({ detail }: { detail: BranchPageDetail }) {
  const { additions, deletions } = detail;
  if (additions == null || deletions == null) {
    return null;
  }
  return <NetLoc additions={additions} deletions={deletions} withLabel />;
}

function FilesList({ files }: { files: readonly LivePrFile[] }) {
  if (files.length === 0) {
    return (
      <p className="py-2 text-muted-foreground text-xs">
        This pull request changed no files.
      </p>
    );
  }
  return (
    <div className="bq-files">
      {files.map((file) => (
        <div className="bq-file" key={file.path}>
          <FileIcon aria-hidden className="bq-file-ic size-3.5" />
          <span className="bq-file-path font-mono">{file.path}</span>
          <span className="ml-auto shrink-0 pl-2">
            <NetLoc additions={file.additions} deletions={file.deletions} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The render state of the files panel. `live` lists files from `/pr/files`
 * (fetched slug-only via `gh`, no local checkout); `no-pr` is the common net-new
 * local branch (no PR to query); `multi-pr` gates ambiguous attribution;
 * `unavailable` is a linked PR whose files can't be fetched (GitHub not
 * connected / not authed). There is genuinely no per-file source for a branch
 * with no connected PR in v1 — so we say so plainly instead of looking broken.
 */
type FilesPanelState =
  | { kind: "loading" }
  | {
      kind: "live";
      files: readonly LivePrFile[];
      count: number;
      additions: number;
      deletions: number;
    }
  | { kind: "no-pr" }
  | { kind: "multi-pr" }
  | { kind: "unavailable"; prNumber: number };

function resolveFilesState(input: {
  live: {
    files: readonly LivePrFile[];
    filesChanged: number;
    additions: number;
    deletions: number;
  } | null;
  identityPresent: boolean;
  hasPr: boolean;
  prNumber: number | null;
  multiPr: boolean;
  isError: boolean;
}): FilesPanelState {
  if (input.live) {
    return {
      kind: "live",
      files: input.live.files,
      count: input.live.filesChanged,
      additions: input.live.additions,
      deletions: input.live.deletions,
    };
  }
  if (!(input.hasPr && input.prNumber != null)) {
    return { kind: "no-pr" };
  }
  if (input.multiPr) {
    return { kind: "multi-pr" };
  }
  // A single PR is linked. If we couldn't form an identity (e.g. a non
  // owner/name slug) or the fetch errored, the files can't be listed; otherwise
  // the query is in flight (or settling) → show the loading skeleton.
  if (!input.identityPresent || input.isError) {
    return { kind: "unavailable", prNumber: input.prNumber };
  }
  return { kind: "loading" };
}

export function BranchFilesChangedPanel({
  detail,
}: BranchFilesChangedPanelProps) {
  const identity = derivePrIdentity({
    repoFullName: detail.repoFullName,
    prNumber: detail.prNumber,
    multiPrWarning: detail.multiPrWarning,
  });
  const filesQuery = useQuery(livePrFilesOptions(identity));

  const state = resolveFilesState({
    // Only trust data for the CURRENT identity — gated/disabled keys never
    // surface another branch's cached files.
    live: identity ? (filesQuery.data ?? null) : null,
    identityPresent: identity != null,
    hasPr: detail.prNumber != null,
    prNumber: detail.prNumber,
    multiPr: detail.multiPrWarning,
    isError: filesQuery.isError,
  });

  return (
    <section className="mt-2">
      <div className="bq-sec-head">
        <span className="bq-sec-title">Files changed</span>
        {state.kind === "live" ? (
          <>
            <span className="bq-sec-count">{state.count}</span>
            {/* PR-sourced totals — authoritative LOC, preferred over enrichment. */}
            <NetLoc
              additions={state.additions}
              deletions={state.deletions}
              withLabel
            />
          </>
        ) : null}
        {/* Source indicator is always present: GitHub when we listed live files,
            else Local filesystem (the derived-LOC fallback's source). */}
        <span className="ml-auto">
          <SourceIndicatorChip
            source={state.kind === "live" ? "github" : "local"}
          />
        </span>
      </div>
      {renderBody({ detail, state })}
    </section>
  );
}

function renderBody({
  detail,
  state,
}: {
  detail: BranchPageDetail;
  state: FilesPanelState;
}) {
  if (state.kind === "loading") {
    return (
      <div className="flex flex-col gap-1.5 py-1">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-3/5" />
      </div>
    );
  }
  if (state.kind === "live") {
    return <FilesList files={state.files} />;
  }
  if (state.kind === "no-pr") {
    return (
      <div className="flex flex-col gap-2 py-1">
        <p className="text-muted-foreground text-xs">
          Changed files appear here once a pull request is opened on this
          branch.
        </p>
        <DerivedLoc detail={detail} />
      </div>
    );
  }
  if (state.kind === "multi-pr") {
    return (
      <div className="flex flex-col gap-2 py-1">
        <p className="text-muted-foreground text-xs">
          Multiple pull requests are linked — changed files aren't shown to
          avoid ambiguous attribution.
        </p>
        <DerivedLoc detail={detail} />
      </div>
    );
  }
  // unavailable — a single PR is linked but its files can't be fetched.
  return (
    <div className="flex flex-col gap-2 py-1">
      <p className="text-muted-foreground text-xs">
        Connect GitHub to list the files changed in pull request #
        {state.prNumber}.
      </p>
      <DerivedLoc detail={detail} />
      <ConnectGitHubIndicator compact />
    </div>
  );
}
