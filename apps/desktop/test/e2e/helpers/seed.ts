/**
 * Seeding helpers for Desktop E2E tests.
 *
 * Two real seed paths the app already ingests — no fakes or test-only hooks:
 *
 *  - Sessions: write Claude transcript `.jsonl` files into a temp CLAUDE_HOME.
 *    The app's historical importer parses them through the utility-process
 *    boundary and they surface in the Sessions list (see
 *    historical-import-utility-worker.spec.ts for the single-session origin).
 *
 *  - Approvals: the main-process ApprovalStore persists its pending queue via
 *    electron-store as `<userData>/desktop-approvals.json`. Writing that file
 *    before launch seeds the queue the Approvals panel reads at boot.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_POISON_TRANSCRIPT_MARKER } from "../../../src/main/collectors/engine/e2e-parse-quarantine-seam.js";

// ─── Sessions ─────────────────────────────────────────────────────────────

export type SeedSession = {
  /** Transcript file stem; also the session id the importer derives. */
  sessionId: string;
  /** Human-readable slug rendered in the Sessions list. */
  slug: string;
  /** First user message text (defaults to a generic prompt). */
  userText?: string;
  /** First assistant reply text (defaults to a generic reply). */
  assistantText?: string;
  /** ISO timestamp for the user turn (defaults to a fresh timestamp). */
  timestamp?: string;
  /** Working directory recorded on the user turn. */
  cwd?: string;
  /** Git branch recorded on the user turn. */
  gitBranch?: string;
  /**
   * Append a successful `git push` tool-use turn for `gitBranch`. FEA-2531:
   * the Branches surface shows push-evidenced branches only, so a transcript
   * that should surface its branch there must contain real push evidence —
   * a start branch alone is a read and never displays.
   */
  pushBranch?: boolean;
};

/**
 * Write one `.jsonl` Claude transcript per session into
 * `<claudeHome>/projects/<project>/`. Pass the returned claudeHome as the
 * `CLAUDE_HOME` env var when launching the app.
 */
export function seedClaudeTranscripts(
  claudeHome: string,
  sessions: SeedSession[],
  project = "e2e-project"
): void {
  const projectDir = path.join(claudeHome, "projects", project);
  fs.mkdirSync(projectDir, { recursive: true });
  const cwd = path.join(os.tmpdir(), project);

  for (const session of sessions) {
    const transcriptPath = path.join(projectDir, `${session.sessionId}.jsonl`);
    const timestamp = session.timestamp ?? recentTranscriptTimestamp();
    // Each element is one raw provider-shaped JSONL record written verbatim to
    // disk (see the `JSON.stringify` below), and the records are deliberately
    // heterogeneous — the `tool_use`/`tool_result` pair appended for
    // `pushBranch` carries fields the opening pair does not. Annotating the
    // array stops TypeScript inferring the narrow shape of the first literal
    // and rejecting the later `push`.
    const lines: Record<string, unknown>[] = [
      {
        type: "user",
        timestamp,
        cwd: session.cwd ?? cwd,
        gitBranch: session.gitBranch ?? "main",
        version: "1.0.0",
        slug: session.slug,
        entrypoint: "claude",
        message: {
          role: "user",
          content: session.userText ?? `Seeded transcript for ${session.slug}.`,
        },
      },
      {
        type: "assistant",
        timestamp: bumpSeconds(timestamp, 5),
        message: {
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: "text",
              text: session.assistantText ?? "Seeded assistant reply.",
            },
          ],
        },
      },
    ];
    if (session.pushBranch) {
      const branch = session.gitBranch ?? "main";
      const toolUseId = `toolu_seed_push_${session.sessionId}`;
      lines.push(
        {
          type: "assistant",
          timestamp: bumpSeconds(timestamp, 10),
          gitBranch: branch,
          message: {
            model: "claude-opus-4-5",
            usage: {
              input_tokens: 8,
              output_tokens: 4,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: "Bash",
                input: { command: `git push -u origin ${branch}` },
              },
            ],
          },
        },
        {
          type: "user",
          timestamp: bumpSeconds(timestamp, 15),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: `branch '${branch}' set up to track 'origin/${branch}'.`,
              },
            ],
          },
        }
      );
    }
    fs.writeFileSync(
      transcriptPath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8"
    );
  }
}

/**
 * ISS-4573: seed a POISON Claude transcript whose filename carries the
 * `E2E_POISON_TRANSCRIPT_MARKER`. Combined with the E2E parse-quarantine launch env
 * (`CLOSEDLOOP_E2E_PARSE_QUARANTINE=1`), the historical-parse worker treats this
 * source's parse as never-settling, so the tightened per-source parse deadline
 * dead-letters it and (with the threshold dropped to 1) quarantines it on the first
 * pass — letting the launched-app E2E reach a nonzero `quarantinedCount` fast. The
 * on-disk shape is a normal Claude transcript; only the filename marker (read by the
 * worker) makes it poison, and only while the seam is armed. Returns the seeded
 * transcript path.
 */
export function seedPoisonClaudeTranscript(
  claudeHome: string,
  project = "e2e-poison-project"
): string {
  const projectDir = path.join(claudeHome, "projects", project);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = `${E2E_POISON_TRANSCRIPT_MARKER}-${Date.now()}`;
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const line = {
    type: "user",
    timestamp,
    cwd: path.join(os.tmpdir(), project),
    gitBranch: "main",
    version: "1.0.0",
    slug: E2E_POISON_TRANSCRIPT_MARKER,
    entrypoint: "claude",
    message: { role: "user", content: "Poison transcript for E2E quarantine." },
  };
  fs.writeFileSync(transcriptPath, `${JSON.stringify(line)}\n`, "utf8");
  return transcriptPath;
}

// ─── Approvals ──────────────────────────────────────────────────────────────

export type SeedApproval = {
  id: string;
  reason: string;
  riskTier?: "low" | "medium" | "high";
  method?: string;
  path?: string;
  location?: string;
  operationId?: string;
  fingerprint?: string;
  createdAt?: string;
};

/**
 * Seed the pending-approval queue by writing the electron-store file the
 * ApprovalStore loads at construction. Call from `beforeLaunch`, before the
 * Electron app boots.
 */
export function seedPendingApprovals(
  userDataDir: string,
  approvals: SeedApproval[]
): void {
  const pending = approvals.map((a) => ({
    id: a.id,
    createdAt: a.createdAt ?? "2026-06-18T18:00:00.000Z",
    operationId: a.operationId ?? `op-${a.id}`,
    riskTier: a.riskTier ?? "medium",
    method: a.method ?? "POST",
    path: a.path ?? "/api/gateway/fs/write",
    location: a.location ?? "/tmp/e2e-workspace",
    reason: a.reason,
    fingerprint: a.fingerprint ?? `fp-${a.id}`,
  }));

  fs.writeFileSync(
    path.join(userDataDir, "desktop-approvals.json"),
    JSON.stringify({ pending }, null, 2),
    "utf8"
  );
}

/** Add `seconds` to an ISO timestamp without pulling in a date library. */
function bumpSeconds(iso: string, seconds: number): string {
  const ms = Date.parse(iso);
  return new Date(ms + seconds * 1000).toISOString();
}

function recentTranscriptTimestamp(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

/**
 * ISS-4677: seed subagent SIDECHAIN transcripts for an already-seeded session,
 * so a desktop-local session detail reports more than one transcript file and
 * the shared `TranscriptFileSwitcher` renders its disclosure.
 *
 * Claude's on-disk layout for sidechains is
 * `<claudeHome>/projects/<project>/<sessionId>/subagents/agent-*.jsonl`. The
 * `agent-` filename prefix is load-bearing: `walkSubagentTranscripts` ignores
 * anything else under `subagents/`.
 */
export function seedClaudeSubagentTranscripts(
  claudeHome: string,
  sessionId: string,
  subagentIds: readonly string[],
  project = "e2e-project"
): void {
  const dir = path.join(
    claudeHome,
    "projects",
    project,
    sessionId,
    "subagents"
  );
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = recentTranscriptTimestamp();
  for (const subagentId of subagentIds) {
    const lines = [
      {
        type: "user",
        timestamp,
        cwd: path.join(os.tmpdir(), project),
        gitBranch: "main",
        version: "1.0.0",
        entrypoint: "claude",
        message: {
          role: "user",
          content: `Sidechain prompt for ${subagentId}.`,
        },
      },
      {
        type: "assistant",
        timestamp: bumpSeconds(timestamp, 5),
        message: {
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 6,
            output_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            { type: "text", text: `Sidechain reply from ${subagentId}.` },
          ],
        },
      },
    ];
    fs.writeFileSync(
      path.join(dir, `${subagentId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8"
    );
  }
}

/**
 * Stamp every seeded transcript under `claudeHome` with `stamp` as its mtime.
 *
 * WHY. The import classifies a run as still-live from the transcript FILE's
 * mtime, not from the timestamps inside the JSONL
 * (`buildImportSessionContext` compares `fileModifiedAt` against
 * `RECENT_ACTIVITY_MS`, 10 minutes). A corpus written moments ago therefore
 * imports entirely as `active`, and everything that selects TERMINAL rows — the
 * data-revision rebuild, and any spec that stales them — then finds nothing at
 * all and silently measures an empty population. So a spec that needs a FINISHED
 * corpus must back-date its files past that window.
 *
 * Takes an EXPLICIT stamp rather than an age-from-now, because this walks the
 * whole corpus and callers seed in more than one batch. With an age-from-now the
 * second batch silently re-dates the FIRST batch's files too, and a changed mtime
 * is precisely what makes the per-file catchup cache treat an
 * already-imported transcript as new work — so the next launch re-imports the
 * corpus it should have skipped. One shared stamp keeps repeat calls idempotent.
 */
export function ageSeededTranscripts(claudeHome: string, stamp: Date): void {
  const projectsRoot = path.join(claudeHome, "projects");
  if (!fs.existsSync(projectsRoot)) {
    return;
  }
  for (const entry of fs.readdirSync(projectsRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!(entry.isFile() && entry.name.endsWith(".jsonl"))) {
      continue;
    }
    fs.utimesSync(path.join(entry.parentPath, entry.name), stamp, stamp);
  }
}
