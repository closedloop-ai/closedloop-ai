/**
 * @file claude-parser.ts
 * @description Desktop file-I/O shell around the shared, browser-safe Claude
 * transcript parser core in `@repo/lib/harness` (FEA-2717; the core was
 * ported from the vendor `scripts/import-history.js` `parseSessionFile`, logic
 * preserved). This module streams a `~/.claude/projects/**​/<sessionId>.jsonl`
 * transcript into the shared `parseClaudeTranscript`, then adds the two pieces
 * that require local disk and are DB-import-specific (not part of the cloud
 * renderer's per-file parse): merging sibling subagent `agent-*.jsonl` token
 * usage into the parent session, and stamping the source-file mtime. Both the
 * desktop and the cloud renderer therefore run exactly one parser.
 *
 * FEA-1459: Token usage is deduped by (message.id, requestId) inside the core.
 * Subagent files live at <sessionDir>/<sessionId>/subagents/agent-*.jsonl and
 * their deduped token usage is folded into the parent below.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  asRecord,
  createSidecarSubagent,
  extractDedupedUsage,
  isoTs,
  parseClaudeTranscript,
  parseJsonValue,
} from "@repo/lib/harness/claude/parse-claude";
import { InvalidTokenCountError } from "@repo/lib/harness/token-counts";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { foldDedupMap, mergeFoldedUsage } from "@repo/lib/harness/usage-dedup";
import {
  createParseQualityScan,
  foldChildParseQuality,
  readJsonlLinesWithQuality,
} from "../engine/parse-quality-scan.js";
import { isImportableSourcePath } from "../engine/source-admission.js";
import { scanSubagentTranscriptStream } from "../parsing/subagent-scanner.js";

/**
 * Parse a Claude transcript file into a NormalizedSession. Returns null when the
 * file has no usable timestamp (matching the vendor contract). Fail-silent on IO
 * or parse errors (malformed lines are skipped); re-throws InvalidTokenCountError.
 */
export async function parseSessionFile(
  filePath: string
): Promise<NormalizedSession | null> {
  const sessionId = path.basename(filePath, ".jsonl");

  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const session = await parseClaudeTranscript(rl, { sessionId });
  if (!session) {
    return null;
  }

  // FEA-1459 Fix 2: Import subagent transcripts (tokens only, no events).
  // Subagent files live at <sessionDir>/<sessionId>/subagents/agent-*.jsonl.
  // This lane is desktop-only: it needs local disk and folds the sibling files'
  // deduped usage into the parent session for the DB import. The cloud renderer
  // fetches each subagent file as its own `subagent:<id>` transcript instead.
  const sessionDir = path.dirname(filePath);
  const subagentsDir = path.join(sessionDir, sessionId, "subagents");
  try {
    const subagentFiles = readdirSync(subagentsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith("agent-") &&
          entry.name.endsWith(".jsonl")
      )
      .map((entry) => path.join(subagentsDir, entry.name))
      .filter((subFile) => isImportableSourcePath(subFile, [sessionDir]))
      // FEA-2646 hermeticity: readdir order is filesystem-dependent; the fold
      // appends order-sensitive arrays (subagents, tokenSeries), so sort to make
      // parse output identical on every machine.
      .sort();
    for (const subFile of subagentFiles) {
      try {
        const {
          entries: subEntries,
          totalLines: subTotalLines,
          malformedLines: subMalformedLines,
          truncatedFinalLine: subTruncatedFinalLine,
        } = await collectEntriesFromFile(subFile);
        // FEA-2905: fold this subagent sidecar's parse-quality into the parent
        // so a corrupt subagent line — which silently drops its folded token
        // usage below — is surfaced rather than masked as a clean parse. The
        // shared `foldChildParseQuality` helper discounts this file's own
        // trailing truncation (benign live/interrupted write); only genuine
        // mid-file corruption inflates the parent's malformed count. In this
        // extraction the shell folds into the RETURNED session's `parseQuality`
        // (NormalizedParseQuality) rather than a desktop `ParseQualityScan`,
        // because the core (not this shell) computed the main-file counts
        // (FEA-2717); the core always sets it, so the guard is a type narrow.
        if (session.parseQuality) {
          foldChildParseQuality(session.parseQuality, {
            totalLines: subTotalLines,
            malformedLines: subMalformedLines,
            truncatedFinalLine: subTruncatedFinalLine,
          });
        }
        const subDedupMap = extractDedupedUsage(subEntries);
        const subFolded = foldDedupMap(subDedupMap);
        mergeFoldedUsage(
          {
            tokensByModel: session.tokensByModel,
            tokenSeries: session.tokenSeries,
          },
          subFolded
        );
        const nativeSubagentId = path.basename(subFile, ".jsonl");
        const subagents = (session.subagents ??= []);
        // The core keys in-line sidechain subagents by their uuid `id`; a sidecar
        // file's id is its `agent-*` basename, so `find` here reproduces the old
        // `acc.subagents.get(nativeSubagentId)` lookup (map keyed on `id`).
        const existing = subagents.find((s) => s.id === nativeSubagentId);
        const subagent =
          existing ??
          createSidecarSubagent(nativeSubagentId, session.startedAt);
        const scanned = await scanSubagentTranscriptStream(
          subFile,
          sessionId,
          nativeSubagentId
        );
        const mergedToolUses = [...(subagent.toolUses ?? [])];
        const seenToolUseIds = new Set(
          mergedToolUses
            .map((toolUse) => toolUse.id)
            .filter((id): id is string => typeof id === "string")
        );
        for (const toolUse of scanned.toolUses.map((toolUse) => ({
          id: toolUse.toolUseId ?? undefined,
          name: toolUse.toolName,
          timestamp: toolUse.timestamp,
          input: toolUse.input ? parseJsonValue(toolUse.input) : undefined,
          output: toolUse.output ? parseJsonValue(toolUse.output) : undefined,
          subagentId: nativeSubagentId,
        }))) {
          if (toolUse.id && seenToolUseIds.has(toolUse.id)) {
            continue;
          }
          if (toolUse.id) {
            seenToolUseIds.add(toolUse.id);
          }
          mergedToolUses.push(toolUse);
        }
        subagent.toolUses = mergedToolUses;
        subagent.tokensByModel = subFolded.tokensByModel;
        subagent.tokenSeries = subFolded.tokenSeries;
        if (!existing) {
          subagents.push(subagent);
        }
      } catch (error) {
        if (error instanceof InvalidTokenCountError) {
          throw error;
        }
        // Fail-silent per subagent file (match existing parser IO error posture).
      }
    }
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      throw error;
    }
    // subagents dir does not exist — normal for most sessions.
  }
  // FEA-1459 Fix 11: The catchup cache now incorporates subagent dir mtime via
  // the claude collector's extraMtime method, so subagent-only changes trigger
  // re-import of the parent session.

  try {
    session.fileModifiedAt = statSync(filePath).mtimeMs;
  } catch {
    /* non-fatal */
  }

  return session;
}

/**
 * FEA-1459 Fix 2: Read a JSONL file and return parsed assistant entries with
 * their ISO timestamps, suitable for feeding into `extractDedupedUsage`. Used
 * for subagent transcript files during the desktop token merge.
 *
 * FEA-2905: also returns the same parse-quality counts the core's main-file loop
 * tracks (`totalLines`/`malformedLines`), so a malformed line in a subagent
 * transcript — which otherwise silently drops that turn's folded token usage
 * from the parent totals — is aggregated into the parent session's
 * `parseQuality` rather than masked as a clean parse. A malformed FINAL line is
 * the tolerable shape of a live/interrupted write, so the caller can discount it
 * instead of reporting it as mid-file corruption.
 */
async function collectEntriesFromFile(filePath: string): Promise<{
  entries: Array<{ entry: Record<string, unknown>; iso: string | null }>;
  totalLines: number;
  malformedLines: number;
  truncatedFinalLine: boolean;
}> {
  const entries: Array<{
    entry: Record<string, unknown>;
    iso: string | null;
  }> = [];
  // Reuse the shared parse-quality scan helper so this sidecar loop tracks
  // malformed-line drops identically to the core's main-file loop.
  const scan = createParseQualityScan();
  for await (const { entry } of readJsonlLinesWithQuality(filePath, scan)) {
    if (entry.type === "assistant") {
      const msg = asRecord(entry.message);
      if (msg.usage) {
        entries.push({ entry, iso: isoTs(entry.timestamp) });
      }
    }
  }
  return {
    entries,
    totalLines: scan.totalLines,
    malformedLines: scan.malformedLines,
    truncatedFinalLine: scan.lastLineMalformed,
  };
}
