/**
 * Findings I/O + dedup — the pure heart of the review pass. A harness writes
 * `.nightly-review/findings.jsonl` (one finding per line); we parse it, guard
 * against issues already open in ClosedLoop (by a stable signature), and stamp a
 * hidden signature marker into each created issue so the NEXT run can dedup.
 *
 * The filing itself ({@link fileFindings}) is a pure function over an injected
 * {@link ClosedLoopClient}, so both the nightly review pass (`review.ts`) and the
 * on-demand desktop "File to ClosedLoop" action (PRD-556 M3) drive the exact same
 * dedup-guarded path — no engine duplication, one signature contract.
 */

import type { CLDocument } from "../clients/closedloop.js";
import { CLStatus, type ClosedLoopClient } from "../clients/closedloop.js";

export type Finding = {
  title: string;
  description: string;
  /** Stable dedup key the reviewer emits; falls back to the title. */
  signature?: string;
  screenshots?: string[];
};

export const SIGNATURE_MARKER = "nightly-signature";

/** Parse a findings.jsonl blob: one JSON object per line; blanks/garbage skipped. */
export function parseFindingsJsonl(text: string): Finding[] {
  const out: Finding[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as Partial<Finding>;
      if (typeof obj.title === "string" && obj.title.trim()) {
        out.push({
          title: obj.title.trim(),
          description:
            typeof obj.description === "string" ? obj.description : "",
          signature:
            typeof obj.signature === "string" ? obj.signature : undefined,
          screenshots: Array.isArray(obj.screenshots)
            ? obj.screenshots.filter((s): s is string => typeof s === "string")
            : undefined,
        });
      }
    } catch {
      /* not a JSON line — skip */
    }
  }
  return out;
}

/** Everything that is not a lowercase alphanumeric — stripped for dedup keys. */
const NON_ALNUM = /[^a-z0-9]+/g;
/** The `nightly-review:` title prefix stripped before keying an existing doc. */
const NIGHTLY_PREFIX = /^nightly-review:\s*/i;

/** Normalize to a dedup key: lowercase alphanumerics only. */
export function normKey(s: string): string {
  return s.toLowerCase().replace(NON_ALNUM, "");
}

/** The dedup key for a finding (signature preferred, else title). */
export function findingKey(f: Finding): string {
  return normKey(f.signature?.trim() ? f.signature : f.title);
}

/** Pull the hidden signature out of an issue body, if present. */
export function extractSignatureMarker(content?: string): string | undefined {
  if (!content) {
    return undefined;
  }
  const m = content.match(
    new RegExp(`<!--\\s*${SIGNATURE_MARKER}:\\s*(.+?)\\s*-->`)
  );
  return m?.[1];
}

/** Append the hidden signature marker to an issue body. */
export function buildIssueContent(
  description: string,
  signature: string
): string {
  return `${description}\n\n<!-- ${SIGNATURE_MARKER}: ${signature} -->`;
}

const DEFAULT_TERMINAL = new Set(["DONE", "CANCELED", "OBSOLETE"]);

/**
 * Build the set of dedup keys already open for a tag/agent, from existing docs.
 * Emits both a title key and a signature-marker key per non-terminal doc so we
 * match issues created before signatures existed too.
 */
export function openKeysFromDocuments(
  docs: CLDocument[],
  terminalStatuses = DEFAULT_TERMINAL
): Set<string> {
  const keys = new Set<string>();
  for (const d of docs) {
    if (terminalStatuses.has(d.status)) {
      continue;
    }
    const title = d.title.replace(NIGHTLY_PREFIX, "");
    keys.add(normKey(title));
    const sig = extractSignatureMarker(d.content);
    if (sig) {
      keys.add(normKey(sig));
    }
  }
  return keys;
}

/** The default `nightly-review:` title prefix stamped onto a filed issue. */
export const DEFAULT_FINDING_TITLE_PREFIX = "nightly-review: ";

/**
 * How a single finding fared when filed: newly created, deduped/skipped, or
 * failed. `Failed` lets a batch report PARTIAL outcomes — if creating one issue
 * throws (e.g. a transient network error), the successes before and after it
 * are still reported as created rather than the whole batch aborting and losing
 * them (which would strand already-created issues and make retry re-dedup them).
 */
export const FiledFindingStatus = {
  /** A new TRIAGE issue was created for this finding. */
  Created: "created",
  /** An open issue with the same signature/title already exists — not re-filed. */
  Skipped: "skipped",
  /** Creating the issue for this finding failed; it was NOT filed (retryable). */
  Failed: "failed",
} as const;
export type FiledFindingStatus =
  (typeof FiledFindingStatus)[keyof typeof FiledFindingStatus];

/** Per-finding outcome, keyed by the finding's dedup key so the UI can map it back. */
export type FiledFindingResult = {
  /** The finding's dedup key ({@link findingKey}) — stable across runs. */
  key: string;
  /** The finding's title (for display when surfacing the outcome). */
  title: string;
  status: FiledFindingStatus;
  /** The created issue's slug/id, when `status === "created"`. */
  documentId?: string;
};

/** The aggregate outcome of a {@link fileFindings} call. */
export type FileFindingsResult = {
  results: FiledFindingResult[];
  created: number;
  skipped: number;
  /** Findings whose issue creation threw — not filed, safe to retry. */
  failed: number;
};

export type FileFindingsOptions = {
  /** The tag attached to every created issue, e.g. `agent-docs-darwin`. */
  tagName: string;
  /** ClosedLoop assignee for the created issues. */
  assigneeId?: string;
  /** Title prefix; defaults to {@link DEFAULT_FINDING_TITLE_PREFIX}. */
  titlePrefix?: string;
  /** Priority for the created TRIAGE issues; defaults to `MEDIUM`. */
  priority?: string;
};

/**
 * File findings as TRIAGE issues via the typed {@link ClosedLoopClient},
 * dedup-guarded by the signature marker. Existing open documents are fetched
 * once and reduced to a key-set (title + signature-marker keys); any finding
 * whose key is already open is skipped rather than re-filed, so re-filing an
 * already-filed finding never creates a duplicate. Each created issue embeds the
 * hidden signature marker so the NEXT filing dedups against it, and is tagged
 * `tagName` (best-effort — a non-admin key that cannot create/attach tags does
 * not fail the filing).
 *
 * Pure w.r.t. the environment: it only touches ClosedLoop through the injected
 * client, so it is unit-testable with a mocked client and reusable across the
 * nightly review pass and the desktop on-demand action.
 */
export async function fileFindings(
  client: ClosedLoopClient,
  findings: readonly Finding[],
  options: FileFindingsOptions
): Promise<FileFindingsResult> {
  const titlePrefix = options.titlePrefix ?? DEFAULT_FINDING_TITLE_PREFIX;
  const [existing, tagId] = await Promise.all([
    client.listDocuments({ type: "FEATURE", limit: 100 }),
    client.ensureTag(options.tagName),
  ]);
  const openKeys = openKeysFromDocuments(existing);

  const results: FiledFindingResult[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const f of findings) {
    const key = findingKey(f);
    if (openKeys.has(key)) {
      skipped++;
      results.push({ key, title: f.title, status: FiledFindingStatus.Skipped });
      continue;
    }
    // Per-finding isolation: a create failure for one finding must not abort
    // the whole batch and strand the issues already created before it. The
    // failed finding is reported as `Failed` (not filed) so the caller keeps it
    // for retry, and dedup is NOT primed for it so a retry can create it.
    try {
      const doc = await createFindingIssue(client, f, {
        titlePrefix,
        tagId,
        assigneeId: options.assigneeId,
        priority: options.priority,
      });
      // Guard against duplicate findings WITHIN this same batch, too.
      openKeys.add(key);
      created++;
      results.push({
        key,
        title: f.title,
        status: FiledFindingStatus.Created,
        documentId: doc.id,
      });
    } catch {
      failed++;
      results.push({ key, title: f.title, status: FiledFindingStatus.Failed });
    }
  }
  return { results, created, skipped, failed };
}

/**
 * Create one TRIAGE issue for a finding and best-effort tag it. Extracted so
 * {@link fileFindings} can isolate each finding's creation in its own
 * try/catch and keep the rest of the batch going on a single failure.
 */
async function createFindingIssue(
  client: ClosedLoopClient,
  finding: Finding,
  opts: {
    titlePrefix: string;
    tagId: string | null;
    assigneeId?: string;
    priority?: string;
  }
): Promise<{ id: string }> {
  const signature = finding.signature?.trim() || finding.title;
  const doc = await client.createDocument({
    type: "FEATURE",
    title: `${opts.titlePrefix}${finding.title}`,
    content: buildIssueContent(finding.description, signature),
    status: CLStatus.Triage,
    priority: opts.priority ?? "MEDIUM",
    assigneeId: opts.assigneeId,
  });
  if (opts.tagId) {
    await client.attachTag(doc.id, opts.tagId).catch(() => {
      /* non-admin key: tag attach is best-effort, filing still succeeds */
    });
  }
  return doc;
}
