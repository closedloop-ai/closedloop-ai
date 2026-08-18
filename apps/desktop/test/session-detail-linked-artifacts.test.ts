/**
 * @file session-detail-linked-artifacts.test.ts
 * @description ISS-5617: the desktop-LOCAL session-detail projection populates
 * `linkedArtifacts`, so the shared Properties pane's "Linked artifacts" row
 * renders on the desktop in local-read mode the way it already does on web.
 *
 * Before this the local producer (`mapDetail`) forwarded transcripts, timeline,
 * activity segments and trace sources and nothing else, while the cloud producer
 * (`apps/api/app/agent-sessions/service/projections.ts`) DID populate the field.
 * `SessionLinkedArtifactsRow` returns `null` on an empty list, so the row was
 * simply absent on every local-mode session — the desktop looked like it had
 * dropped data the web app showed for the same run.
 *
 * The load-bearing assertions are the two halves of "populated" and "genuinely
 * empty":
 *
 *  - a session that HAS `closedloop_artifact` links projects one pill-ready
 *    entry per distinct slug, carrying the `documentType` the shared row's href
 *    builder needs — a slug-only entry would render an INERT pill and the two
 *    surfaces would still disagree about reachability;
 *  - a session with NO document links leaves the key ABSENT, so the row keeps
 *    returning `null`. Making "no linked artifacts" render as something is a
 *    different bug, and this file is what stops the fix from causing it.
 *
 * Both drive the real SQLite → `loadSyncedSessions` → `getSharedAgentSessionDetail`
 * boundary rather than a hand-built session, because the field-population gap is
 * only closed if the detail READ actually hydrates the artifact links it projects.
 *
 * Lives in its own file because `apps/desktop/test/shared-agent-sessions-api.test.ts`
 * is a grandfathered over-ceiling file.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DocumentType } from "@repo/api/src/types/document";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
  MIN_SYNCED_DOCUMENT_REFS_PRODUCER,
  SessionArtifactLinkRole,
} from "@repo/api/src/types/session-artifact-link";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { projectLocalLinkedArtifacts } from "../src/main/session/local-linked-artifacts.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import { createSessionAttributionResolverCache } from "../src/main/session/shared-agent-sessions-api.js";

const SESSION_ID = "iss5617-session";
const AT = "2026-07-10T00:00:00.000Z";

type TestDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function openDb(dir: string): Promise<TestDb> {
  return await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => AT,
  });
}

/** One `closedloop_artifact` artifact plus its session link. */
async function seedDocumentLink(
  db: TestDb,
  options: {
    key: string;
    slug: string;
    method: string;
    isPrimary?: boolean;
    title?: string | null;
  }
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO artifacts (id, identity_key, kind, slug, title, created_at, last_seen_at)
     VALUES (?, ?, 'closedloop_artifact', ?, ?, ?, ?)`,
    `art-${options.key}`,
    `closedloop_artifact:${options.key}`,
    options.slug,
    options.title ?? null,
    AT,
    AT
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary, extractor_version, observed_at, created_at)
     VALUES (?, ?, ?, 'referenced', ?, '{}', ?, 1, ?, ?)`,
    `link-${options.key}`,
    SESSION_ID,
    `art-${options.key}`,
    options.method,
    options.isPrimary ? 1 : 0,
    AT,
    AT
  );
}

test("ISS-5617: the desktop-local detail projects its session's document links as pill-ready linked artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5617-linked-"));
  const db = await openDb(dir);
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES (?, 'completed')",
      SESSION_ID
    );
    await seedDocumentLink(db, {
      key: "iss",
      slug: "ISS-5617",
      method: ArtifactRefMethod.McpToolCall,
      isPrimary: true,
    });
    await seedDocumentLink(db, {
      key: "prd",
      slug: "PRD-567",
      method: ArtifactRefMethod.SlugInMessage,
    });

    const detail = await getSharedAgentSessionDetail(db.syncSource, SESSION_ID);
    assert.ok(detail, "the local detail resolves");

    const bySlug = new Map(
      (detail.linkedArtifacts ?? []).map((artifact) => [
        artifact.slug,
        artifact,
      ])
    );
    assert.deepEqual(
      [...bySlug.keys()].sort(),
      ["ISS-5617", "PRD-567"],
      "every distinct document link reaches the pill row"
    );
    // The href the shared row builds is `documentType` + `slug`
    // (`buildArtifactWebHref` → `getDocumentTypeRoute`), so a null type here is
    // an inert pill and the surfaces still disagree about reachability.
    assert.equal(bySlug.get("ISS-5617")?.documentType, DocumentType.Feature);
    assert.equal(bySlug.get("PRD-567")?.documentType, DocumentType.Prd);
    // `role` is derived by the SAME `roleFromMethod` the cloud ingest lane uses
    // to persist the link metadata the cloud projection reads back, so the two
    // producers cannot drift on it.
    assert.equal(bySlug.get("ISS-5617")?.role, SessionArtifactLinkRole.Input);
    assert.equal(
      bySlug.get("PRD-567")?.role,
      SessionArtifactLinkRole.Referenced
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5617: the same slug reached by two methods projects ONE pill at the higher-precedence role", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5617-dedupe-"));
  const db = await openDb(dir);
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES (?, 'completed')",
      SESSION_ID
    );
    // Two distinct artifact rows carrying the SAME slug — the shape a rebuild or
    // a second extraction pass produces. The cloud folds these to one link, so a
    // local projection that emitted two would put a duplicate pill on the
    // desktop that the web row never shows.
    await seedDocumentLink(db, {
      key: "dupe-a",
      slug: "ISS-5617",
      method: ArtifactRefMethod.SlugInMessage,
    });
    await seedDocumentLink(db, {
      key: "dupe-b",
      slug: "ISS-5617",
      method: ArtifactRefMethod.LaunchMetadata,
    });

    const detail = await getSharedAgentSessionDetail(db.syncSource, SESSION_ID);
    assert.ok(detail, "the local detail resolves");
    assert.equal(detail.linkedArtifacts?.length, 1, "one pill per slug");
    assert.equal(detail.linkedArtifacts?.[0]?.slug, "ISS-5617");
    assert.equal(
      detail.linkedArtifacts?.[0]?.role,
      SessionArtifactLinkRole.Input,
      "launch_metadata outranks a prose mention"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5617: a session with no document links leaves linkedArtifacts ABSENT so the row still renders nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5617-empty-"));
  const db = await openDb(dir);
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES (?, 'completed')",
      SESSION_ID
    );
    // A BRANCH link, not a document one: the branch/PR lanes own their own rows,
    // so this must not leak into the Linked-artifacts pill row.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
       VALUES ('art-branch', 'branch:iss5617', 'branch', 'closedloop-ai/symphony-alpha', 'fix/iss-5617', ?, ?)`,
      AT,
      AT
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES ('link-branch', ?, 'art-branch', 'workspace', 'git_command', '{}', 1, ?, ?)`,
      SESSION_ID,
      AT,
      AT
    );

    const detail = await getSharedAgentSessionDetail(db.syncSource, SESSION_ID);
    assert.ok(detail, "the local detail resolves");
    // ABSENT, not `[]` and not `null`: the shared pane reads presence, and the
    // shared row's `linkedArtifacts.length === 0` early return is what keeps a
    // link-less session from growing an empty labelled row.
    assert.equal(
      Object.hasOwn(detail, "linkedArtifacts"),
      false,
      "no document links means the key is omitted entirely"
    );
    assert.equal(
      Object.hasOwn(detail, "linkedArtifactsTotal"),
      false,
      "and no total is fabricated for a set that does not exist"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5617: a non-document slug prefix grows no row, so the desktop cannot list a session the web pane would not", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5617-untyped-"));
  const db = await openDb(dir);
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES (?, 'completed')",
      SESSION_ID
    );
    // `PRO-` (project) and `WRK-` (workflow) are in the extractor's
    // referenceable alphabet but are NOT Document artifacts, and
    // `slug_in_session_slug` emits the session's OWN `SES-` slug. The cloud
    // drops all three — its projection keeps only `ArtifactType.Document`
    // targets and its ingest lane skips self-links — so a local projection that
    // passed them through would put a "Linked artifacts" row on the desktop for
    // a session that shows none on web, and in the `SES-` case would have the
    // session list itself.
    await seedDocumentLink(db, {
      key: "project",
      slug: "PRO-42",
      method: ArtifactRefMethod.SlugInCwd,
    });
    await seedDocumentLink(db, {
      key: "self",
      slug: "SES-88",
      method: ArtifactRefMethod.SlugInSessionSlug,
    });

    const detail = await getSharedAgentSessionDetail(db.syncSource, SESSION_ID);
    assert.ok(detail, "the local detail resolves");
    assert.equal(
      Object.hasOwn(detail, "linkedArtifacts"),
      false,
      "no document-typed link means no row at all"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5617: the FEA/ISS spellings of one issue fold to a single pill", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5617-alias-"));
  const db = await openDb(dir);
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES (?, 'completed')",
      SESSION_ID
    );
    // FEA-4137 renamed Feature → Issue, so `FEA-1952` and `ISS-1952` address ONE
    // artifact. A session picks up both routinely: a `fea-1952-*` branch name
    // plus a prose `ISS-1952`. The cloud resolves both spellings to one artifact
    // and emits one link, so folding on the raw slug string here would render a
    // duplicate pill the web row never shows.
    await seedDocumentLink(db, {
      key: "alias-legacy",
      slug: "fea-1952",
      method: ArtifactRefMethod.SlugInBranch,
    });
    await seedDocumentLink(db, {
      key: "alias-canonical",
      slug: "ISS-1952",
      method: ArtifactRefMethod.SlugInMessage,
    });

    const detail = await getSharedAgentSessionDetail(db.syncSource, SESSION_ID);
    assert.ok(detail, "the local detail resolves");
    assert.equal(
      detail.linkedArtifacts?.length,
      1,
      "one pill per artifact, not per spelling"
    );
    // The surviving pill keeps an ADDRESSABLE slug — upper-cased, because the
    // by-slug lookup behind the web route is case-sensitive and `fea-1952` 404s.
    assert.equal(detail.linkedArtifacts?.[0]?.slug, "FEA-1952");
    assert.equal(
      detail.linkedArtifacts?.[0]?.documentType,
      DocumentType.Feature
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5617: the projector yields nothing for a session that carries no refs at all", () => {
  // The `artifactRefs` key is OMITTED entirely by the sync source when a session
  // has no refs, so `undefined` is the shape the projector actually receives for
  // the overwhelmingly common session — distinct from the loop's kind filter,
  // which is what the branch-only case above exercises.
  assert.deepEqual(projectLocalLinkedArtifacts(undefined), []);
  assert.deepEqual(projectLocalLinkedArtifacts([]), []);
});

/**
 * ISS-5617 (codex review): the "Linked artifacts" total must describe the local
 * link set, not the SYNC-capped payload the batch loader hands the detail.
 *
 * `loadSyncedSessions` runs `boundNonCommitArtifactRefs` over every session it
 * hydrates — a 100-slot budget SHARED by the `closedloop_artifact`, `branch` and
 * `pull_request` kinds, inside which documents hold only a floor of 50
 * (`MIN_SYNCED_DOCUMENT_REFS_PRODUCER`). That budget exists so a new desktop
 * cannot emit an array an old cloud would reject; it is a WIRE constraint and it
 * has no business shaping a local read.
 *
 * The corpus below is the smallest one that makes the difference visible: 60
 * document links + 50 branch links = 110 non-commit refs, so the budget keeps 50
 * documents and drops 10. Folded from that, the row served 50 pills and reported
 * 50 as the total — and with `VISIBLE_LINKED_ARTIFACTS = 6` the overflow chip
 * read "+44" when the honest answer was "+54". Ten of the user's own linked
 * artifacts were unreachable and nothing on screen said so.
 *
 * The first assertion pins the PREMISE (the batch loader really does cap) so
 * this test cannot quietly become vacuous if the budget moves; the rest pin that
 * the detail read bypassed it and that the served list and the reported total
 * describe one set.
 */
test("ISS-5617: the detail serves every local document link and reports a total the sync budget cannot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5617-capped-"));
  const db = await openDb(dir);
  const documentLinkCount = 60;
  const branchLinkCount = 50;
  try {
    await db.run(
      "INSERT INTO sessions (id, status) VALUES (?, 'completed')",
      SESSION_ID
    );
    for (let index = 0; index < documentLinkCount; index += 1) {
      await seedDocumentLink(db, {
        key: `capped-${index}`,
        slug: `ISS-${6000 + index}`,
        method: ArtifactRefMethod.SlugInMessage,
      });
    }
    // The other half of the shared budget. Branch refs are what actually crowd
    // documents out in the field (a long-running session touches many), and they
    // ride the same 100 slots.
    for (let index = 0; index < branchLinkCount; index += 1) {
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
         VALUES (?, ?, 'branch', 'closedloop-ai/symphony-alpha', ?, ?, ?)`,
        `art-cap-branch-${index}`,
        `branch:iss5617-cap-${index}`,
        `fix/iss-5617-cap-${index}`,
        AT,
        AT
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES (?, ?, ?, 'workspace', 'git_command', '{}', 1, ?, ?)`,
        `link-cap-branch-${index}`,
        SESSION_ID,
        `art-cap-branch-${index}`,
        AT,
        AT
      );
    }

    // PREMISE: the batch hydrate the detail used to fold from really does drop
    // document refs on this corpus. If this ever stops being true the rest of
    // the test is no longer proving anything, and it fails here rather than
    // passing for the wrong reason.
    const [synced] = await db.syncSource.loadSyncedSessions(
      [SESSION_ID],
      createSessionAttributionResolverCache()
    );
    const syncedDocumentRefs = (synced?.artifactRefs ?? []).filter(
      (ref) => ref.kind === ArtifactRefTargetKind.ClosedloopArtifact
    );
    assert.equal(
      syncedDocumentRefs.length,
      MIN_SYNCED_DOCUMENT_REFS_PRODUCER,
      "the sync producer budget caps this corpus at the document floor"
    );
    assert.ok(
      syncedDocumentRefs.length < documentLinkCount,
      "so folding the synced refs would under-serve the row"
    );

    const detail = await getSharedAgentSessionDetail(db.syncSource, SESSION_ID);
    assert.ok(detail, "the local detail resolves");
    assert.equal(
      detail.linkedArtifacts?.length,
      documentLinkCount,
      "the detail serves EVERY local document link, not the wire-budgeted subset"
    );
    assert.equal(
      detail.linkedArtifactsTotal,
      documentLinkCount,
      "and reports the true total — 50 here is the capped lie this test exists to catch"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
