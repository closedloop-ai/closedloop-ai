/**
 * @file live-transcript-ref-resolver.test.ts
 * @description ISS-4390 — the live child-transcript key resolver.
 *
 * The load-bearing property is PARITY: a key this resolver computes for a file
 * from a watcher event must be byte-identical to the key the 30-min discovery
 * sweep computes for that same file. If the two ever disagree, one transcript is
 * archived twice under two different object keys. Those parity tests use the
 * REAL discovery mappers against a real on-disk fixture rather than restating
 * the expected string, so a change to either derivation fails here.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  listClaudeSubagentTranscriptFiles,
  relIdFromSubagentPath,
} from "../src/main/collectors/claude/claude-home.js";
import { mapCodexRolloutsById } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import {
  claudeSubagentsDirForTranscript,
  resolveLiveTranscriptFileKey,
} from "../src/main/transcript-sync/live-transcript-ref-resolver.js";
import {
  claudeRefsFromListings,
  codexRefsFromRollouts,
} from "../src/main/transcript-sync/transcript-discovery.js";
import { TranscriptSourceHarness } from "../src/main/transcript-sync/transcript-sync-types.js";
import { resolveTrustedClaudeTranscriptPath } from "../src/main/transcript-sync/trusted-transcript-path.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iss4390-"));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A Claude projects tree: `<projects>/<proj>/<sessionId>.jsonl` plus a direct
 * sidecar and a nested workflow agent under `<sessionId>/subagents/`.
 */
function makeClaudeFixture(): {
  projectsDir: string;
  mainPath: string;
  sidecarPath: string;
  nestedPath: string;
} {
  const root = makeTempRoot();
  const projectsDir = path.join(root, "projects");
  const projDir = path.join(projectsDir, "proj");
  const subagents = path.join(projDir, "sess-1", "subagents");
  mkdirSync(path.join(subagents, "workflows", "wf-1"), { recursive: true });
  const mainPath = path.join(projDir, "sess-1.jsonl");
  const sidecarPath = path.join(subagents, "agent-abc.jsonl");
  const nestedPath = path.join(
    subagents,
    "workflows",
    "wf-1",
    "agent-nested.jsonl"
  );
  for (const file of [mainPath, sidecarPath, nestedPath]) {
    writeFileSync(file, "{}\n");
  }
  return { projectsDir, mainPath, sidecarPath, nestedPath };
}

/** A Codex root rollout plus a child whose `session_meta` names it as parent. */
function makeCodexFixture(): {
  rootPath: string;
  childPath: string;
  rootId: string;
  childId: string;
} {
  const root = makeTempRoot();
  const sessions = path.join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const rootId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const rootPath = path.join(
    sessions,
    `rollout-2026-07-30T00-00-00-${rootId}.jsonl`
  );
  const childPath = path.join(
    sessions,
    `rollout-2026-07-30T00-01-00-${childId}.jsonl`
  );
  writeFileSync(
    rootPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: rootId } })}\n`
  );
  writeFileSync(
    childPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: childId,
        source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
      },
    })}\n`
  );
  return { rootPath, childPath, rootId, childId };
}

// ── Claude ──────────────────────────────────────────────────────────────────

test("ISS-4390: a Claude sidecar resolves to its subagent key", () => {
  const { mainPath, sidecarPath } = makeClaudeFixture();
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mainPath,
      sidecarPath
    ),
    "subagent:agent-abc"
  );
});

test("ISS-4390: a nested Claude workflow agent keeps its collision-free key", () => {
  const { mainPath, nestedPath } = makeClaudeFixture();
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mainPath,
      nestedPath
    ),
    "subagent:workflows__wf-1__agent-nested"
  );
});

test("ISS-4390: a Claude change that IS the mapped source stays main", () => {
  const { mainPath } = makeClaudeFixture();
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mainPath,
      mainPath
    ),
    "main"
  );
});

test("ISS-4390: an unrecognized Claude path resolves to null, never to main", () => {
  // Returning `main` here would be actively harmful, not a safe default: the
  // caller pairs the returned key with the CHILD's path, so a `main` key files
  // the child's bytes into the main transcript's row and advances main's byte
  // cursor over content that is not main's. Null makes the caller drop it.
  const { mainPath } = makeClaudeFixture();
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mainPath,
      path.join(path.dirname(mainPath), "some-other-session.jsonl")
    ),
    null
  );
});

test("ISS-4390: a sidecar still resolves when the projects tree is reached through a symlink", () => {
  // The changed path arrives realpath-canonicalized (the caller routes it
  // through the trust guard) while the mapped source comes straight off the
  // collector seam un-canonicalized. Without symmetric canonicalization the
  // containment check false-negatives on every install whose `~/.claude` is
  // reached through a symlink — a relocated dotfile tree, a home-manager setup,
  // a container bind-mount — stranding all their child transcripts.
  const { projectsDir, mainPath, sidecarPath } = makeClaudeFixture();
  const linkRoot = makeTempRoot();
  const linkedProjects = path.join(linkRoot, "linked-projects");
  symlinkSync(projectsDir, linkedProjects);

  // The seam reports the path THROUGH the symlink; the guard reports the real one.
  const mappedThroughLink = path.join(
    linkedProjects,
    path.relative(projectsDir, mainPath)
  );
  const changedRealPath = realpathSync(sidecarPath);

  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mappedThroughLink,
      changedRealPath
    ),
    "subagent:agent-abc",
    "a symlinked projects tree must not strand the sidecar"
  );
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mainPath,
      changedRealPath
    ),
    "subagent:agent-abc",
    "and the un-symlinked path still agrees"
  );
});

test("ISS-4390: a non-agent .jsonl under subagents/ mints no key", () => {
  // Claude's `watchMatch` admits EVERY `.jsonl`, but the discovery walk emits
  // only `agent-*.jsonl`. Minting a key for a workflow journal/index file would
  // archive an object the sweep never enumerates or reconciles — an archived
  // file with no local counterpart.
  const { mainPath, sidecarPath } = makeClaudeFixture();
  const journal = path.join(
    path.dirname(sidecarPath),
    "workflow-journal.jsonl"
  );
  writeFileSync(journal, "{}\n");
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mainPath,
      journal
    ),
    null
  );
});

test("ISS-4390: the live resolver admits exactly what the discovery walk enumerates", () => {
  // Parity as a set, not just per-file: anything the resolver keys must appear
  // in the sweep's enumeration for the same session.
  const { projectsDir, mainPath, sidecarPath, nestedPath } =
    makeClaudeFixture();
  const journal = path.join(path.dirname(sidecarPath), "notes.jsonl");
  const tooDeep = path.join(
    path.dirname(sidecarPath),
    "a/b/c/d/e/f/g/h/i",
    "agent-deep.jsonl"
  );
  mkdirSync(path.dirname(tooDeep), { recursive: true });
  writeFileSync(journal, "{}\n");
  writeFileSync(tooDeep, "{}\n");

  const previousClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = path.dirname(projectsDir);
  try {
    const sweptPaths = new Set(
      listClaudeSubagentTranscriptFiles().map((f) => realpathSync(f.filePath))
    );
    for (const candidate of [sidecarPath, nestedPath, journal, tooDeep]) {
      const key = resolveLiveTranscriptFileKey(
        TranscriptSourceHarness.Claude,
        mainPath,
        candidate
      );
      assert.equal(
        key !== null,
        sweptPaths.has(realpathSync(candidate)),
        `${candidate}: live-keyed and sweep-enumerated must agree`
      );
    }
  } finally {
    if (previousClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
  }
});

test("ISS-4390: claudeSubagentsDirForTranscript derives the dir with no filesystem access", () => {
  assert.equal(
    claudeSubagentsDirForTranscript(path.join("/p", "proj", "sess-1.jsonl")),
    path.join("/p", "proj", "sess-1", "subagents")
  );
});

// ── Codex ───────────────────────────────────────────────────────────────────

test("ISS-4390: a Codex child rollout resolves to its meta-derived subagent key", () => {
  const { rootPath, childPath, childId } = makeCodexFixture();
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Codex,
      rootPath,
      childPath
    ),
    `subagent:${childId}`
  );
});

test("ISS-4390: a Codex change that IS the mapped root stays main", () => {
  const { rootPath } = makeCodexFixture();
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Codex,
      rootPath,
      rootPath
    ),
    "main"
  );
});

// ── Parity with the discovery sweep (the reason this resolver exists) ────────

test("ISS-4390: the live Claude child key equals the discovery sweep's key", () => {
  const { projectsDir, mainPath, sidecarPath, nestedPath } =
    makeClaudeFixture();
  const previousClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = path.dirname(projectsDir);
  try {
    const sweptRefs = claudeRefsFromListings(
      [mainPath],
      listClaudeSubagentTranscriptFiles()
    );
    for (const changedPath of [sidecarPath, nestedPath]) {
      const swept = sweptRefs.find((ref) => ref.sourcePath === changedPath);
      assert.ok(swept, `discovery did not enumerate ${changedPath}`);
      assert.equal(
        resolveLiveTranscriptFileKey(
          TranscriptSourceHarness.Claude,
          mainPath,
          changedPath
        ),
        swept.fileKey,
        "a live child enqueue and the sweep must address ONE archive object"
      );
    }
  } finally {
    if (previousClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
  }
});

test("ISS-4390: the live Codex child key equals the discovery sweep's key", () => {
  const { rootPath, childPath } = makeCodexFixture();
  const sweptRefs = codexRefsFromRollouts(
    mapCodexRolloutsById([rootPath, childPath])
  );
  const swept = sweptRefs.find((ref) => ref.sourcePath === childPath);
  assert.ok(swept, "discovery did not enumerate the child rollout");
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Codex,
      rootPath,
      childPath
    ),
    swept.fileKey,
    "a live child enqueue and the sweep must address ONE archive object"
  );
});

test("ISS-4390: the Codex child key follows session_meta, not the filename", () => {
  // `readCodexRolloutLinkage` prefers the rollout's own `session_meta.id` and
  // only falls back to the filename uuid. Deriving the key from the path would
  // silently disagree with discovery for any rollout whose meta id differs.
  const root = makeTempRoot();
  const sessions = path.join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const rootPath = path.join(sessions, "rollout-root.jsonl");
  const childPath = path.join(sessions, "rollout-child-filename.jsonl");
  writeFileSync(
    rootPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: "root-id" } })}\n`
  );
  writeFileSync(
    childPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: { id: "meta-child-id", parent_thread_id: "root-id" },
    })}\n`
  );

  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Codex,
      rootPath,
      childPath
    ),
    "subagent:meta-child-id"
  );
});

// ── Trust guard admits child paths (ISS-4390 T1.6) ───────────────────────────

test("ISS-4390: the transcript trust guard admits a Claude subagent sidecar", () => {
  // The guard is root-containment + `.jsonl` + regular-file, with no basename
  // restriction — but a rejection here would silently no-op EVERY live child
  // enqueue, so it is asserted rather than assumed.
  const { projectsDir, sidecarPath, nestedPath } = makeClaudeFixture();
  const previousClaudeHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = path.dirname(projectsDir);
  try {
    for (const childPath of [sidecarPath, nestedPath]) {
      // The guard returns the REALPATH-canonicalized path by contract (so the
      // caller uploads the vetted path, not a re-openable symlink), which on
      // macOS differs from the temp path by the `/var` → `/private/var` link.
      assert.equal(
        resolveTrustedClaudeTranscriptPath(childPath),
        realpathSync(childPath),
        `${childPath} must resolve through the trust anchor`
      );
    }
  } finally {
    if (previousClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
  }
});

test("ISS-4390: relIdFromSubagentPath is the one derivation both lanes call", () => {
  // Guards the SSOT: if the resolver ever stops routing through this helper,
  // the two lanes can drift on the escaping rules and produce two keys.
  const { mainPath, nestedPath } = makeClaudeFixture();
  const subagentsDir = claudeSubagentsDirForTranscript(mainPath);
  assert.equal(
    resolveLiveTranscriptFileKey(
      TranscriptSourceHarness.Claude,
      mainPath,
      nestedPath
    ),
    `subagent:${relIdFromSubagentPath(subagentsDir, nestedPath)}`
  );
});
