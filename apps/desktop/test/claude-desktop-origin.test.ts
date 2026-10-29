/**
 * @file claude-desktop-origin.test.ts
 * @description ISS-7198: a Claude Code session launched from Claude Desktop must
 * be DISTINGUISHABLE from one launched in a terminal, and a session with no
 * Desktop sidecar must stay valid and UNATTRIBUTED.
 *
 * Those two facts are one contract, so every case here is written as a pair. A
 * test that only asserted the enriched side would stay green if the collector
 * stamped a default origin onto every session — which would destroy the
 * distinction while looking like the feature works. The unattributed control is
 * therefore asserted at the same depth as the attributed case, down to the
 * persisted metadata blob being byte-identical to the pre-capture one.
 *
 * The chain asserted is the production chain: the COLLECTOR's `parse` (which is
 * what both the in-process import and the utility-process worker call), then
 * `buildImportMetadata`, then the `.strict()` worker-response boundary. Testing
 * only the index would prove the reader works while the join, the blob, or the
 * wire silently dropped it.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { MAX_METADATA_STRING_CHARS } from "@repo/lib/agent-sessions/metadata-preview";
import { afterEach, describe, test } from "vitest";
import { createClaudeCollector } from "../src/main/collectors/claude/claude-collector.js";
import {
  createClaudeDesktopOriginIndex,
  MAX_SIDECAR_BYTES,
  MAX_SIDECAR_ID_CHARS,
} from "../src/main/collectors/claude/claude-desktop-origin.js";
import { createCatchupCache } from "../src/main/collectors/engine/catchup-cache.js";
import {
  createHistoricalParseWorkerParsedResponse,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  type ClaudeDesktopOrigin,
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import { buildImportMetadata } from "../src/main/database/import-metadata-builders.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

const DESKTOP_SESSION_ID = "local_54aded2b-0000-4000-a000-000000000001";
const ROUTINE_ID = "nightly-reconcile";
const DESKTOP_TITLE = "Test local routine";

/** A transcript line that gives the parser the timestamp it needs to emit a session. */
function transcriptLine(cwd: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-08-19T16:00:00.000Z",
    cwd,
    message: { role: "user", content: "hello" },
  });
}

/** Stage a Claude transcript under a projects-style tree and return its path. */
function writeTranscript(root: string, sessionId: string): string {
  const projectDir = path.join(root, "-workspace-project");
  mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(filePath, `${transcriptLine("/workspace/project")}\n`);
  return filePath;
}

/**
 * Stage a subagent sidechain transcript beside `transcriptPath`, stamped to a
 * given year, and return its mtime — the other clock `extraMtime` folds in.
 */
function writeSubagent(
  transcriptPath: string,
  sessionId: string,
  year: string
): number {
  const dir = path.join(path.dirname(transcriptPath), sessionId, "subagents");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "agent-abc123.jsonl");
  writeFileSync(filePath, `${transcriptLine("/workspace/project")}\n`);
  const stamp = new Date(`${year}-01-01T00:00:00.000Z`);
  utimesSync(filePath, stamp, stamp);
  return stamp.getTime();
}

/**
 * Stage one Claude Desktop origin sidecar at the real
 * `<root>/<orgId>/<userId>/local_<uuid>.json` layout.
 */
function writeSidecar(
  root: string,
  fileName: string,
  body: Record<string, unknown>
): string {
  const dir = path.join(root, "org-1", "user-1");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, JSON.stringify(body));
  return filePath;
}

/** The verified sidecar shape, including keys this reader does not consume. */
function sidecarBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    sessionId: DESKTOP_SESSION_ID,
    cliSessionId: "eae130b7-1ea9-44bb-a7a8-52547bcc079c",
    cwd: "/workspace/project",
    originCwd: "/workspace/project",
    createdAt: 1_785_211_483_921,
    lastActivityAt: 1_785_211_488_536,
    model: "claude-opus-5[1m]",
    isArchived: false,
    title: DESKTOP_TITLE,
    permissionMode: "acceptEdits",
    remoteMcpServersConfig: [],
    reportFindingsCard: true,
    ...overrides,
  };
}

/**
 * Parse one transcript through the real collector, pointed at a staged sidecar
 * root. `desktopSessionsDir` is threaded rather than the process env so two
 * cases in this file can hold different hosts at once.
 */
async function parseWithSidecarRoot(
  transcriptPath: string,
  desktopSessionsDir: string | null
): Promise<NormalizedSession> {
  const collector = createClaudeCollector({
    listSources: () => [transcriptPath],
    watchRoots: () => [path.dirname(path.dirname(transcriptPath))],
    desktopSessionsDir,
  });
  const sessions = await collector.parse(transcriptPath);
  if (sessions.length !== 1) {
    throw new Error(
      `expected exactly one parsed session, got ${sessions.length}`
    );
  }
  return sessions[0];
}

describe("ISS-7198 — Claude Desktop launch attribution", () => {
  test("a Desktop-launched session is distinguishable from a terminal one", async () => {
    // The load-bearing pair. Both transcripts are byte-identical apart from
    // their session id; the ONLY thing that separates them is the sidecar.
    const transcripts = makeTempDir("claude-desktop-origin-transcripts-");
    const sidecars = makeTempDir("claude-desktop-origin-sidecars-");
    const desktopSessionId = "eae130b7-1ea9-44bb-a7a8-52547bcc079c";
    const terminalSessionId = "11111111-2222-4333-8444-555555555555";
    writeSidecar(sidecars, "local_a.json", sidecarBody());

    const desktopSession = await parseWithSidecarRoot(
      writeTranscript(transcripts, desktopSessionId),
      sidecars
    );
    const terminalSession = await parseWithSidecarRoot(
      writeTranscript(transcripts, terminalSessionId),
      sidecars
    );

    assert.deepEqual(desktopSession.claudeDesktopOrigin, {
      sessionId: DESKTOP_SESSION_ID,
      title: DESKTOP_TITLE,
      scheduledTaskId: null,
      archived: false,
    } satisfies ClaudeDesktopOrigin);
    // The counterfactual, at the same depth: the sidecar tree EXISTS and is
    // readable, and this session still carries no origin. Absent, not defaulted.
    assert.equal(terminalSession.claudeDesktopOrigin, undefined);
  });

  test("the persisted blob carries the origin key only when there is an origin", async () => {
    // The honest-null case where it actually bites: if the key were ever emitted
    // unconditionally, the blob would change for every terminal session on every
    // machine — flipping `sessionDataChanged`, rewriting the whole corpus, and
    // drifting the frozen golden layer-2 metadata hashes.
    //
    // The discriminator is an ATTRIBUTED session, not the unattributed one with
    // its key deleted: that pairing is `f(x)` vs `f(x)` and cannot fail under any
    // implementation, since `JSON.stringify` drops an `undefined` value anyway.
    // Stripping the origin off a session that HAS one must reproduce the
    // unattributed blob byte-for-byte, and keeping it must not.
    const transcripts = makeTempDir("claude-desktop-origin-blob-");
    const sidecars = makeTempDir("claude-desktop-origin-blob-sidecars-");
    const attributedId = "22222222-3333-4444-8555-666666666666";
    const terminalId = "22222222-3333-4444-8555-777777777777";
    writeSidecar(
      sidecars,
      "local_blob.json",
      sidecarBody({ cliSessionId: attributedId })
    );
    const attributed = await parseWithSidecarRoot(
      writeTranscript(transcripts, attributedId),
      sidecars
    );
    const terminal = await parseWithSidecarRoot(
      writeTranscript(transcripts, terminalId),
      sidecars
    );
    // Same session id on both sides, so the only difference the blob can show is
    // the origin key itself.
    const { claudeDesktopOrigin: _stripped, ...attributedWithoutOrigin } =
      attributed;
    const withOrigin = buildImportMetadata(attributed, Harness.Claude);
    const withoutOrigin = buildImportMetadata(
      attributedWithoutOrigin as NormalizedSession,
      Harness.Claude
    );

    assert.notEqual(withOrigin, withoutOrigin);
    assert.equal(
      withoutOrigin,
      buildImportMetadata(
        { ...terminal, sessionId: attributed.sessionId, name: attributed.name },
        Harness.Claude
      )
    );
    assert.equal(
      JSON.parse(buildImportMetadata(terminal, Harness.Claude))
        .claudeDesktopOrigin,
      undefined
    );
    assert.deepEqual(
      JSON.parse(withOrigin).claudeDesktopOrigin,
      attributed.claudeDesktopOrigin
    );
  });

  test("a routine-launched session carries its scheduled-task linkage", async () => {
    const transcripts = makeTempDir("claude-desktop-origin-routine-");
    const sidecars = makeTempDir("claude-desktop-origin-routine-sidecars-");
    const routineSessionId = "33333333-4444-4555-8666-777777777777";
    const interactiveSessionId = "44444444-5555-4666-8777-888888888888";
    writeSidecar(
      sidecars,
      "local_routine.json",
      sidecarBody({
        cliSessionId: routineSessionId,
        scheduledTaskId: ROUTINE_ID,
        isArchived: true,
      })
    );
    writeSidecar(
      sidecars,
      "local_interactive.json",
      sidecarBody({ cliSessionId: interactiveSessionId })
    );

    const routine = await parseWithSidecarRoot(
      writeTranscript(transcripts, routineSessionId),
      sidecars
    );
    const interactive = await parseWithSidecarRoot(
      writeTranscript(transcripts, interactiveSessionId),
      sidecars
    );

    assert.equal(routine.claudeDesktopOrigin?.scheduledTaskId, ROUTINE_ID);
    assert.equal(routine.claudeDesktopOrigin?.archived, true);
    // A Desktop launch that was NOT a routine is not a routine with a blank id.
    assert.equal(interactive.claudeDesktopOrigin?.scheduledTaskId, null);
    assert.equal(interactive.claudeDesktopOrigin?.archived, false);
  });

  test("the origin survives the strict worker-response boundary", async () => {
    // The historical/boot import runs the collector in a utility process, so an
    // origin the schema does not model would reject the WHOLE response and drop
    // the session — and the in-process path would never see it.
    const transcripts = makeTempDir("claude-desktop-origin-wire-");
    const sidecars = makeTempDir("claude-desktop-origin-wire-sidecars-");
    const cliSessionId = "55555555-6666-4777-8888-999999999999";
    writeSidecar(
      sidecars,
      "local_wire.json",
      sidecarBody({ cliSessionId, scheduledTaskId: ROUTINE_ID })
    );
    const session = await parseWithSidecarRoot(
      writeTranscript(transcripts, cliSessionId),
      sidecars
    );

    const result = historicalParseWorkerResponseSchema.safeParse(
      createHistoricalParseWorkerParsedResponse("req-1", [session])
    );
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.deepEqual(
      result.success && result.data.type === "parsed"
        ? result.data.sessions[0].claudeDesktopOrigin
        : null,
      session.claudeDesktopOrigin
    );
  });

  test("ids AT the decoder's cap round-trip the strict worker boundary", async () => {
    // The decoder's id cap and the worker response's short-text cap are two
    // separate numbers that MUST agree, and only a round trip can prove they do.
    // If the decoder ever admitted an id longer than the boundary accepts, the
    // `.strict()` schema would reject the ENTIRE response — every session in that
    // source dropped, and re-dropped on every retry — while a decoder-only test
    // of the same value stayed green.
    const transcripts = makeTempDir("claude-desktop-origin-capwire-");
    const sidecars = makeTempDir("claude-desktop-origin-capwire-side-");
    const cliSessionId = "eeeeeeee-ffff-4000-8111-222222222222";
    const atCap = "x".repeat(MAX_SIDECAR_ID_CHARS);
    writeSidecar(
      sidecars,
      "local_capwire.json",
      sidecarBody({
        cliSessionId,
        sessionId: atCap,
        scheduledTaskId: atCap,
        title: "t".repeat(50_000),
      })
    );
    const session = await parseWithSidecarRoot(
      writeTranscript(transcripts, cliSessionId),
      sidecars
    );
    assert.equal(session.claudeDesktopOrigin?.sessionId, atCap);

    const result = historicalParseWorkerResponseSchema.safeParse(
      createHistoricalParseWorkerParsedResponse("req-cap", [session])
    );
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.deepEqual(
      result.success && result.data.type === "parsed"
        ? result.data.sessions[0].claudeDesktopOrigin
        : null,
      session.claudeDesktopOrigin
    );
  });

  test("an over-long id drops only the origin, not the whole worker response", async () => {
    // The failure this bound exists to prevent, asserted where it would actually
    // bite. An id past the cap must make THAT sidecar undecodable and leave the
    // session importing unattributed — the response still valid, the session
    // still present. The malformed origin is dropped alone.
    const transcripts = makeTempDir("claude-desktop-origin-overcap-");
    const sidecars = makeTempDir("claude-desktop-origin-overcap-side-");
    const cliSessionId = "eeeeeeee-ffff-4000-8111-333333333333";
    writeSidecar(
      sidecars,
      "local_overcap.json",
      sidecarBody({
        cliSessionId,
        scheduledTaskId: "x".repeat(MAX_SIDECAR_ID_CHARS + 1),
      })
    );
    const session = await parseWithSidecarRoot(
      writeTranscript(transcripts, cliSessionId),
      sidecars
    );
    assert.equal(session.claudeDesktopOrigin, undefined);

    const result = historicalParseWorkerResponseSchema.safeParse(
      createHistoricalParseWorkerParsedResponse("req-overcap", [session])
    );
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.equal(
      result.success && result.data.type === "parsed"
        ? result.data.sessions.length
        : 0,
      1,
      "the session must survive the boundary its malformed sidecar did not"
    );
  });

  test("a deleted sidecar re-imports the session and clears its origin", async () => {
    // Nothing else clears a persisted `claudeDesktopOrigin`. The import writes
    // the metadata blob only when the catchup cache says the source changed, and
    // losing a sidecar LOWERS the folded extra-mtime fingerprint — which a
    // greater-than test read as "unchanged". The session then kept serving an
    // origin whose file no longer existed until the transcript itself changed.
    const transcripts = makeTempDir("claude-desktop-origin-deleted-");
    const sidecars = makeTempDir("claude-desktop-origin-deleted-sidecars-");
    const cliSessionId = "dddddddd-eeee-4fff-8000-111111111111";
    const transcriptPath = writeTranscript(transcripts, cliSessionId);
    const sidecarPath = writeSidecar(
      sidecars,
      "local_deleted.json",
      sidecarBody({ cliSessionId })
    );
    const collector = createClaudeCollector({
      listSources: () => [transcriptPath],
      watchRoots: () => [transcripts],
      desktopSessionsDir: sidecars,
      desktopOriginRefreshTtlMs: 0,
    });
    await collector.prepareSourceBatch?.([transcriptPath]);
    const attributedExtra = collector.extraMtime?.(transcriptPath) ?? null;
    const [attributed] = await collector.parse(transcriptPath);
    assert.equal(attributed.claudeDesktopOrigin?.sessionId, DESKTOP_SESSION_ID);
    assert.ok(
      attributedExtra !== null && attributedExtra > 0,
      `an attributed session must fold a real fingerprint, got ${attributedExtra}`
    );

    // What the cache holds for this source at the moment the sidecar vanishes.
    const cache = createCatchupCache();
    cache.markSeenWith(
      transcriptPath,
      statSync(transcriptPath),
      attributedExtra
    );
    assert.equal(
      cache.isUnchanged(transcriptPath, attributedExtra).unchanged,
      true,
      "the cache must consider an untouched source unchanged"
    );

    rmSync(sidecarPath);
    await collector.prepareSourceBatch?.([transcriptPath]);
    const absentExtra = collector.extraMtime?.(transcriptPath) ?? null;
    assert.notEqual(
      absentExtra,
      null,
      "an active sidecar reader must still fold a fingerprint when there is none"
    );
    assert.notEqual(
      absentExtra,
      attributedExtra,
      "losing the sidecar must change the fingerprint"
    );
    assert.equal(
      cache.isUnchanged(transcriptPath, absentExtra).unchanged,
      false,
      "the source must re-import so the stale origin is rewritten away"
    );
    const [cleared] = await collector.parse(transcriptPath);
    assert.equal(cleared.claudeDesktopOrigin, undefined);
  });

  test("a session with no origin also survives that boundary unchanged", async () => {
    const transcripts = makeTempDir("claude-desktop-origin-wire-absent-");
    const sidecars = makeTempDir("claude-desktop-origin-wire-absent-side-");
    const session = await parseWithSidecarRoot(
      writeTranscript(transcripts, "66666666-7777-4888-8999-aaaaaaaaaaaa"),
      sidecars
    );
    const result = historicalParseWorkerResponseSchema.safeParse(
      createHistoricalParseWorkerParsedResponse("req-2", [session])
    );
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.equal(
      result.success && result.data.type === "parsed"
        ? "claudeDesktopOrigin" in result.data.sessions[0]
        : true,
      false,
      "an absent origin must stay ABSENT on the wire, not become null"
    );
  });

  test("an explicitly disabled sidecar root never consults the host", async () => {
    // Golden mode passes `null`. A staged corpus must not pick up whatever
    // Desktop history the developer's own machine happens to hold.
    const transcripts = makeTempDir("claude-desktop-origin-disabled-");
    const sidecars = makeTempDir("claude-desktop-origin-disabled-sidecars-");
    const cliSessionId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    writeSidecar(sidecars, "local_x.json", sidecarBody({ cliSessionId }));
    const session = await parseWithSidecarRoot(
      writeTranscript(transcripts, cliSessionId),
      null
    );
    assert.equal(session.claudeDesktopOrigin, undefined);
  });

  test("a sidecar-only write still invalidates the catchup cache", () => {
    // Desktop writes the title on its own clock. Without the sidecar's mtime in
    // `extraMtime`, a title arriving after the transcript's last write would
    // leave the session unattributed until an unrelated edit — the ISS-4592
    // `.meta.json` staleness trap, in a second place.
    const transcripts = makeTempDir("claude-desktop-origin-mtime-");
    const sidecars = makeTempDir("claude-desktop-origin-mtime-sidecars-");
    const cliSessionId = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const transcriptPath = writeTranscript(transcripts, cliSessionId);
    const sidecarPath = writeSidecar(
      sidecars,
      "local_mtime.json",
      sidecarBody({ cliSessionId })
    );
    const future = new Date("2030-01-01T00:00:00.000Z");
    utimesSync(sidecarPath, future, future);

    const collector = createClaudeCollector({
      listSources: () => [transcriptPath],
      watchRoots: () => [transcripts],
      desktopSessionsDir: sidecars,
    });
    assert.equal(collector.extraMtime?.(transcriptPath), future.getTime());

    const unattributed = createClaudeCollector({
      listSources: () => [transcriptPath],
      watchRoots: () => [transcripts],
      desktopSessionsDir: null,
    });
    assert.equal(unattributed.extraMtime?.(transcriptPath), null);
  });

  test("a batch-driven pass scans the sidecar tree ONCE, never per source", async () => {
    // The scan seam is load-bearing three times over. It must actually refresh —
    // a sidecar written after the first build has to become visible — it must be
    // cooperative, and the per-pass COST has to be one scan for the whole batch.
    // The alternative the collectors' AGENTS.md forbids (reading source metadata
    // from each per-source hook) re-walks and re-stats the entire tree once per
    // source, which near the 20k-file bound is the difference between one sweep
    // and tens of thousands. That is asserted as a scan COUNT, per that same
    // rule ("dependency call counts … rather than wall-clock timing"), because a
    // timing assertion here would prove nothing and flake.
    const transcripts = makeTempDir("claude-desktop-origin-prepare-");
    const sidecars = makeTempDir("claude-desktop-origin-prepare-sidecars-");
    const cliSessionIds = [
      "bbbbbbbb-cccc-4ddd-8eee-ffffffffff01",
      "bbbbbbbb-cccc-4ddd-8eee-ffffffffff02",
      "bbbbbbbb-cccc-4ddd-8eee-ffffffffff03",
    ];
    const transcriptPaths = cliSessionIds.map((id) =>
      writeTranscript(transcripts, id)
    );
    let scans = 0;
    const collector = createClaudeCollector({
      listSources: () => transcriptPaths,
      watchRoots: () => [transcripts],
      desktopSessionsDir: sidecars,
      // Zero TTL so the refresh is driven by the call, not by wall-clock luck.
      desktopOriginRefreshTtlMs: 0,
      onDesktopOriginScan: () => {
        scans++;
      },
    });

    const pending = collector.prepareSourceBatch?.(transcriptPaths);
    assert.ok(
      pending instanceof Promise,
      "prepareSourceBatch must be cooperative (async)"
    );
    await pending;
    assert.equal(scans, 1, "the batch seam scans exactly once");

    // Every per-source hook the scan loop runs, across every source. None may
    // scan: this is the assertion that fails if the tree is ever re-walked from
    // `extraMtime` or `parse` while a batch seam is driving the index.
    for (const transcriptPath of transcriptPaths) {
      collector.extraMtime?.(transcriptPath);
      await collector.parse(transcriptPath);
    }
    assert.equal(
      scans,
      1,
      `${transcriptPaths.length} sources' hooks must add no scans, got ${scans}`
    );

    // A sidecar written mid-pass stays invisible until the NEXT batch, which is
    // the flip side of that same guarantee — the accessors are snapshot reads.
    writeSidecar(
      sidecars,
      "local_late.json",
      sidecarBody({ cliSessionId: cliSessionIds[0] })
    );
    assert.equal(scans, 1);
    const [beforeRefresh] = await collector.parse(transcriptPaths[0]);
    assert.equal(beforeRefresh.claudeDesktopOrigin, undefined);
    assert.equal(scans, 1, "a mid-pass accessor still must not scan");

    await collector.prepareSourceBatch?.(transcriptPaths);
    assert.equal(scans, 2, "the next batch is the second and only other scan");
    const [afterRefresh] = await collector.parse(transcriptPaths[0]);
    assert.equal(
      afterRefresh.claudeDesktopOrigin?.sessionId,
      DESKTOP_SESSION_ID
    );
  });

  test("a worker-shaped reader with no batch seam still sees an edited sidecar", async () => {
    // The utility-process worker (`engine/historical-parse-source.ts`) caches ONE
    // collector for the life of the process and calls `parse` directly — it never
    // drives `prepareSourceBatch`. Answering every parse from the boot-time build
    // makes a Desktop title rename or archive toggle PERMANENT: the main process
    // notices the sidecar mtime move and re-sends the source, the worker returns
    // the stale origin anyway, and the catchup cache then advances past the
    // change so the source is never sent again.
    const transcripts = makeTempDir("claude-desktop-origin-worker-");
    const sidecars = makeTempDir("claude-desktop-origin-worker-sidecars-");
    const cliSessionId = "cccccccc-dddd-4eee-8fff-000000000001";
    const transcriptPath = writeTranscript(transcripts, cliSessionId);
    const sidecarPath = writeSidecar(
      sidecars,
      "local_worker.json",
      sidecarBody({ cliSessionId, title: "Before the rename" })
    );
    let scans = 0;
    // No `prepareSourceBatch` call anywhere in this test — that is the point.
    const worker = createClaudeCollector({
      listSources: () => [transcriptPath],
      watchRoots: () => [transcripts],
      desktopSessionsDir: sidecars,
      onDesktopOriginScan: () => {
        scans++;
      },
    });
    const [first] = await worker.parse(transcriptPath);
    assert.equal(first.claudeDesktopOrigin?.title, "Before the rename");
    assert.equal(scans, 1, "the lazy first build is one scan");

    // An IN-PLACE edit: the file identity moves, but no directory mtime does, so
    // only re-checking the file this answer came from can see it.
    writeFileSync(
      sidecarPath,
      JSON.stringify(
        sidecarBody({
          cliSessionId,
          title: "After the rename",
          isArchived: true,
        })
      )
    );
    const later = new Date("2031-01-01T00:00:00.000Z");
    utimesSync(sidecarPath, later, later);

    const [second] = await worker.parse(transcriptPath);
    assert.equal(second.claudeDesktopOrigin?.title, "After the rename");
    assert.equal(second.claudeDesktopOrigin?.archived, true);

    // A settled tree must not keep rescanning: re-reading it changes nothing and
    // must cost no further scans, or the fix would just be a per-parse rescan.
    const scansAfterEdit = scans;
    await worker.parse(transcriptPath);
    await worker.parse(transcriptPath);
    assert.equal(
      scans,
      scansAfterEdit,
      "an unchanged tree must not be rescanned on every parse"
    );
  });

  test("a worker-shaped reader picks up a sidecar that arrives later", async () => {
    // The other half: a session with NO entry cannot be checked file-by-file,
    // because there is no file to check. A sidecar CREATED under the root bumps
    // its parent directory's mtime, which is what makes the arrival visible.
    const transcripts = makeTempDir("claude-desktop-origin-worker-new-");
    const sidecars = makeTempDir("claude-desktop-origin-worker-new-side-");
    const cliSessionId = "cccccccc-dddd-4eee-8fff-000000000002";
    const transcriptPath = writeTranscript(transcripts, cliSessionId);
    // Establish the tree (and the worker's first build) with an unrelated
    // sidecar, so the arrival below is an addition to a tree that already exists.
    writeSidecar(
      sidecars,
      "local_other.json",
      sidecarBody({ cliSessionId: "cccccccc-dddd-4eee-8fff-0000000000ff" })
    );
    const worker = createClaudeCollector({
      listSources: () => [transcriptPath],
      watchRoots: () => [transcripts],
      desktopSessionsDir: sidecars,
    });
    const [unattributed] = await worker.parse(transcriptPath);
    assert.equal(unattributed.claudeDesktopOrigin, undefined);

    writeSidecar(sidecars, "local_arrived.json", sidecarBody({ cliSessionId }));
    const [attributed] = await worker.parse(transcriptPath);
    assert.equal(
      attributed.claudeDesktopOrigin?.sessionId,
      DESKTOP_SESSION_ID,
      "a sidecar that arrived after the build must not wait for a restart"
    );
  });

  test("a sidecar write invalidates even when a subagent file is newer", () => {
    // The case a max() of the two clocks silently loses, and the case the
    // no-subagent fixture above cannot see. The catchup cache only invalidates on
    // `extra > cachedExtra`, so if the newest subagent file already outranks the
    // sidecar, a max would leave the value unchanged and the session would never
    // gain its origin. The fold has to move when EITHER clock moves.
    const transcripts = makeTempDir("claude-desktop-origin-twoclock-");
    const sidecars = makeTempDir("claude-desktop-origin-twoclock-sidecars-");
    const cliSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const transcriptPath = writeTranscript(transcripts, cliSessionId);
    const subagentMtime = writeSubagent(transcriptPath, cliSessionId, "2031");
    const sidecarPath = writeSidecar(
      sidecars,
      "local_twoclock.json",
      sidecarBody({ cliSessionId })
    );
    const olderSidecar = new Date("2030-01-01T00:00:00.000Z");
    utimesSync(sidecarPath, olderSidecar, olderSidecar);

    const withSidecar = createClaudeCollector({
      listSources: () => [transcriptPath],
      watchRoots: () => [transcripts],
      desktopSessionsDir: sidecars,
    });
    const subagentOnly = createClaudeCollector({
      listSources: () => [transcriptPath],
      watchRoots: () => [transcripts],
      desktopSessionsDir: null,
    });

    // The pre-ISS-7198 value for this session, i.e. what the catchup cache holds.
    assert.equal(subagentOnly.extraMtime?.(transcriptPath), subagentMtime);
    const combined = withSidecar.extraMtime?.(transcriptPath);
    assert.ok(
      combined !== null && combined !== undefined && combined > subagentMtime,
      `folding in an OLDER sidecar must still exceed the cached ${subagentMtime}, got ${combined}`
    );
  });
});

describe("ISS-7198 — sidecar decode", () => {
  const cliSessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const DECODE_FIXTURE_MTIME = new Date("2029-01-01T00:00:00.000Z");

  /** Build an index over a freshly staged root holding exactly `bodies`. */
  function indexOver(
    label: string,
    bodies: { fileName: string; body: unknown }[]
  ): ReturnType<typeof createClaudeDesktopOriginIndex> {
    const root = makeTempDir(`claude-desktop-origin-decode-${label}-`);
    const dir = path.join(root, "org-1", "user-1");
    mkdirSync(dir, { recursive: true });
    for (const { fileName, body } of bodies) {
      const filePath = path.join(dir, fileName);
      writeFileSync(
        filePath,
        typeof body === "string" ? body : JSON.stringify(body)
      );
      // Every file gets the SAME mtime, so the file clock never accidentally
      // breaks a tie these cases mean to leave tied. Cases that care about
      // ordering vary `lastActivityAt`, which is Desktop's own clock.
      utimesSync(filePath, DECODE_FIXTURE_MTIME, DECODE_FIXTURE_MTIME);
    }
    return createClaudeDesktopOriginIndex({ sessionsDir: root });
  }

  test("an unknown Desktop field does not defeat the decode", () => {
    // Version skew: Claude Desktop owns this format and will add fields. A
    // strict decode would turn the next app release into a total loss of
    // attribution for every session on the machine.
    const index = indexOver("skew", [
      {
        fileName: "local_skew.json",
        body: sidecarBody({
          cliSessionId,
          someFieldAShippedDesktopAdds: { nested: true },
        }),
      },
    ]);
    assert.equal(index.lookup(cliSessionId)?.sessionId, DESKTOP_SESSION_ID);
  });

  test("a malformed sidecar yields no origin rather than a partial one", () => {
    // Each of these is bad EXTERNAL data at a trust boundary, so each is
    // reachable at runtime regardless of the in-process types. None may produce
    // a half-populated origin, because a half-populated one would be persisted.
    const cases: { label: string; body: unknown }[] = [
      { label: "not-json", body: "{ this is not json" },
      { label: "no-cli-id", body: { sessionId: DESKTOP_SESSION_ID } },
      { label: "empty-cli-id", body: sidecarBody({ cliSessionId: "" }) },
      { label: "wrong-types", body: sidecarBody({ cliSessionId: 42 }) },
      { label: "array", body: [sidecarBody({ cliSessionId })] },
    ];
    for (const { label, body } of cases) {
      const index = indexOver(label, [
        { fileName: `local_${label}.json`, body },
      ]);
      assert.equal(
        index.lookup(cliSessionId),
        null,
        `${label} must decode to no origin`
      );
    }
  });

  test("a blank Desktop title reads as no title, not an empty one", () => {
    const index = indexOver("blank-title", [
      {
        fileName: "local_blank.json",
        body: sidecarBody({ cliSessionId, title: "   " }),
      },
    ]);
    assert.equal(index.lookup(cliSessionId)?.title, null);
  });

  test("a pathological Desktop title is bounded at capture", () => {
    // The title is the one free-text member — user content. It is capped where
    // it is read so nothing downstream has to re-truncate it, and so a
    // hand-edited sidecar cannot inflate every sync payload for that session.
    const index = indexOver("long-title", [
      {
        fileName: "local_long.json",
        body: sidecarBody({ cliSessionId, title: "x".repeat(50_000) }),
      },
    ]);
    assert.equal(
      index.lookup(cliSessionId)?.title?.length,
      MAX_METADATA_STRING_CHARS
    );
  });

  test("an over-long id makes the whole sidecar undecodable", () => {
    // An id is identity, so it is REJECTED rather than truncated — a truncated id
    // is a different id. The session then imports unattributed, which is the
    // module's contract. Left uncapped, the id would decode here and then fail
    // the `.strict()` worker-response schema, rejecting the ENTIRE response and
    // dropping every session in that source on every retry.
    for (const field of ["sessionId", "cliSessionId", "scheduledTaskId"]) {
      const index = indexOver(`long-${field.toLowerCase()}`, [
        {
          fileName: "local_longid.json",
          body: sidecarBody({
            cliSessionId,
            [field]: "x".repeat(MAX_SIDECAR_ID_CHARS + 1),
          }),
        },
      ]);
      assert.equal(
        index.lookup(cliSessionId),
        null,
        `an over-long ${field} must yield no origin`
      );
    }
  });

  test("an id at the cap still decodes, so the bound is not off by one", () => {
    const atCap = "x".repeat(MAX_SIDECAR_ID_CHARS);
    const index = indexOver("cap-id", [
      {
        fileName: "local_capid.json",
        body: sidecarBody({ cliSessionId, scheduledTaskId: atCap }),
      },
    ]);
    assert.equal(index.lookup(cliSessionId)?.scheduledTaskId, atCap);
  });

  test("two sidecars for one CLI session resolve to the newest, deterministically", () => {
    // Desktop can relaunch a CLI session under a new local id. Whichever file
    // the filesystem enumerates first must not decide the answer, or a rebuild
    // would converge on a different origin than the original import.
    const newest = "local_zzz-newest.json";
    const oldest = "local_aaa-oldest.json";
    const bodies = [
      {
        fileName: oldest,
        body: sidecarBody({
          cliSessionId,
          sessionId: "local_old",
          lastActivityAt: 1,
        }),
      },
      {
        fileName: newest,
        body: sidecarBody({
          cliSessionId,
          sessionId: "local_new",
          lastActivityAt: 2,
        }),
      },
    ];
    assert.equal(
      indexOver("dupe-forward", bodies).lookup(cliSessionId)?.sessionId,
      "local_new"
    );
    assert.equal(
      indexOver("dupe-reverse", [...bodies].reverse()).lookup(cliSessionId)
        ?.sessionId,
      "local_new"
    );
  });

  test("two sidecars tied on BOTH clocks resolve the same way regardless of order", () => {
    // `lastActivityAt` ties whenever Desktop never recorded one (both collapse to
    // 0), and two files written in the same millisecond tie on mtime too. With
    // both clocks tied, returning the incumbent hands the answer to directory
    // enumeration order, so the same pair of sidecars can resolve differently on
    // two machines — or differently on a rebuild of the same machine.
    //
    // Enumeration order is not controllable here, so the counterfactual is built
    // the other way round: two roots holding the SAME pair of origins, with the
    // filenames swapped. Whatever order the filesystem uses, it admits them in
    // opposite content-orders across the two roots, so an order-dependent
    // tiebreak must disagree between them.
    const tied = { lastActivityAt: 0 };
    const forward = indexOver("tie-forward", [
      {
        fileName: "local_aaa.json",
        body: sidecarBody({ ...tied, cliSessionId, sessionId: "local_alpha" }),
      },
      {
        fileName: "local_zzz.json",
        body: sidecarBody({ ...tied, cliSessionId, sessionId: "local_omega" }),
      },
    ]);
    const swapped = indexOver("tie-swapped", [
      {
        fileName: "local_aaa.json",
        body: sidecarBody({ ...tied, cliSessionId, sessionId: "local_omega" }),
      },
      {
        fileName: "local_zzz.json",
        body: sidecarBody({ ...tied, cliSessionId, sessionId: "local_alpha" }),
      },
    ]);
    const forwardWinner = forward.lookup(cliSessionId)?.sessionId;
    assert.equal(
      forwardWinner,
      swapped.lookup(cliSessionId)?.sessionId,
      "a fully tied pair must not be decided by which file was seen first"
    );
    // And the winner is derived from the content, not from an arbitrary slot.
    assert.equal(forwardWinner, "local_omega");
  });

  test("an oversized sidecar is rejected from its stat, never read", () => {
    // The read is synchronous and runs on the Electron main process, so a single
    // oversized `local_*.json` — hand-edited, corrupt, or a log written to the
    // path — would block or OOM the app before any parse-time bound applied. The
    // bound is therefore taken from `stat`, ahead of the read.
    const oversized = sidecarBody({
      cliSessionId,
      // A member this decoder ignores, so the file is otherwise perfectly valid
      // and its SIZE is the only reason it is refused.
      remoteMcpServersConfig: ["p".repeat(MAX_SIDECAR_BYTES)],
    });
    assert.ok(
      JSON.stringify(oversized).length > MAX_SIDECAR_BYTES,
      "fixture must actually exceed the byte bound"
    );
    assert.equal(
      indexOver("oversized", [
        { fileName: "local_big.json", body: oversized },
      ]).lookup(cliSessionId),
      null,
      "an oversized sidecar must yield no origin"
    );
    // The counterfactual: the same shape under the bound still decodes, so the
    // rejection is about the size and not about the extra member.
    assert.equal(
      indexOver("undersized", [
        {
          fileName: "local_small.json",
          body: sidecarBody({
            cliSessionId,
            remoteMcpServersConfig: ["p".repeat(1024)],
          }),
        },
      ]).lookup(cliSessionId)?.sessionId,
      DESKTOP_SESSION_ID
    );
  });

  test("a missing sidecar tree is a no-op, not a failure", () => {
    const index = createClaudeDesktopOriginIndex({
      sessionsDir: path.join(
        makeTempDir("claude-desktop-origin-absent-"),
        "nope"
      ),
    });
    assert.equal(index.lookup(cliSessionId), null);
    assert.equal(index.mtimeFor(cliSessionId), null);
  });
});
