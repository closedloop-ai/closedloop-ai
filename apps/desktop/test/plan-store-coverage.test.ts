/**
 * @file plan-store-coverage.test.ts
 * @description ISS-10514 branch-coverage top-up for `plan-store.ts`, alongside
 * the existing `plan-store-conversion.test.ts` (whole read/write path) and
 * `plan-store-title.test.ts` (`titleFromMarkdown` regex equivalence).
 *
 * Covers: `planKeyFor`'s fallback chain (blank first line, non-normalizable
 * title/source, an all-slashes `file_path`, the codex-harness prefix),
 * `makeCapture`'s null-content and empty-`filePath` coercions,
 * `extractPlansFromPlansDir`'s real-filesystem skip rules (non-file entries,
 * empty files), and `upsertPlanWithin`/`upsertPlanVersion` DB edge cases that
 * the conversion suite's fixtures never produce: an identical-content dedup
 * with nothing to backfill, a dedup that backfills `source_log_path` when
 * `file_path` is absent, a raw capture with empty `title`/`capture_method`
 * strings, and a `plans` row seeded with zero `plan_versions` rows.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPlansFromPlansDir,
  getPlan,
  getPlanVersions,
  listPlans,
  makeCapture,
  type PlanCapture,
  planKeyFor,
  upsertPlan,
  upsertPlanVersion,
} from "../src/main/plans/plan-store.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const BASE_CAPTURE: PlanCapture = {
  harness: "claude",
  source: "raw-test",
  capture_method: "extractor",
  created_from_session_id: null,
  title: "Untitled",
  file_path: null,
  source_log_path: null,
  content_markdown: "body",
  content_sha256: "sha-base",
  confidence: 1.0,
  needs_confirmation: false,
  source_event_ref: null,
  captured_at: null,
};

function rawCapture(overrides: Partial<PlanCapture>): PlanCapture {
  return { ...BASE_CAPTURE, ...overrides };
}

describe("planKeyFor", () => {
  it("skips a blank first line before deriving the key from the next non-blank line", () => {
    const capture = rawCapture({
      content_markdown: "\nActual Content Line",
      created_from_session_id: "sess1",
    });
    expect(planKeyFor(capture)).toBe("sess1:actual-content-line");
  });

  it("falls through content, title, and source to the 'plan' literal when none normalize to a key part; a missing session falls back to 'nosession'", () => {
    const capture = rawCapture({
      content_markdown: "",
      title: "---",
      source: "###",
      created_from_session_id: null,
    });
    expect(planKeyFor(capture)).toBe("nosession:plan");
  });

  it("falls through to the content-derived key when file_path has no basename", () => {
    const capture = rawCapture({
      file_path: "///",
      content_markdown: "# Real Heading",
      created_from_session_id: "s2",
    });
    expect(planKeyFor(capture)).toBe("s2:real-heading");
  });

  it("prefixes the key with ':codex:' when harness is codex", () => {
    const capture = rawCapture({
      harness: "codex",
      content_markdown: "# Codex Plan",
      created_from_session_id: "s3",
    });
    expect(planKeyFor(capture)).toBe("s3:codex:codex-plan");
  });
});

describe("makeCapture", () => {
  it("coerces null content to empty markdown and falls back to 'Plan (source)' when filePath has no basename", () => {
    const capture = makeCapture({
      harness: "claude",
      source: "empty-path-test",
      captureMethod: "file",
      sessionId: null,
      content: null,
      filePath: "",
      confidence: 1.0,
    });
    expect(capture.content_markdown).toBe("");
    expect(capture.file_path).toBe("");
    expect(capture.title).toBe("Plan (empty-path-test)");
  });

  it("falls back to the file's basename (extension stripped) when content has no heading", () => {
    const capture = makeCapture({
      harness: "claude",
      source: "basename-test",
      captureMethod: "file",
      sessionId: null,
      content: null,
      filePath: "/tmp/my-plan.md",
      confidence: 1.0,
    });
    expect(capture.title).toBe("my-plan");
  });
});

describe("extractPlansFromPlansDir", () => {
  it("skips non-file entries, empty files, whitespace-only files, and a non-.md-suffixed name, and captures a valid markdown plan file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plan-store-coverage-"));
    try {
      mkdirSync(path.join(dir, "a-subdir"));
      writeFileSync(path.join(dir, "empty.md"), "");
      writeFileSync(path.join(dir, "whitespace.md"), "   \n\t  ");
      // Contains ".md" mid-name but doesn't END in .md/.mdx — must stay
      // excluded even though the substring is present.
      writeFileSync(path.join(dir, "stale.md.bak"), "not a real plan file");
      writeFileSync(path.join(dir, "real.md"), "# Real Plan\n\nBody text");

      const captures = extractPlansFromPlansDir(dir);

      expect(captures).toHaveLength(1);
      const [captured] = captures;
      expect(captured.harness).toBe("claude");
      expect(captured.source).toBe("claude-plan-file");
      expect(captured.capture_method).toBe("file");
      expect(captured.confidence).toBe(1.0);
      expect(captured.file_path).toBe(path.join(dir, "real.md"));
      expect(captured.content_markdown).toBe("# Real Plan\n\nBody text");
      expect(captured.source_event_ref).toBe("plansdir:real.md");
      expect(typeof captured.captured_at).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("upsertPlan / upsertPlanWithin edge cases", () => {
  it("identical-content dedup with no session, file_path, or source_log_path backfills nothing", async () => {
    const { prisma, close } = await openTestPrisma();
    try {
      const capture = makeCapture({
        harness: "claude",
        source: "t7",
        captureMethod: "extractor",
        sessionId: null,
        content: "dedup body 7",
        confidence: 1.0,
      });
      const first = await upsertPlan(prisma, capture);
      const second = await upsertPlan(prisma, capture);

      expect(second.deduped).toBe(true);
      expect(second.planId).toBe(first.planId);
      const plan = await getPlan(prisma, first.planId);
      expect(plan?.sessionId).toBeNull();
      expect(plan?.filePath).toBeNull();
      expect(plan?.sourceLogPath).toBeNull();
    } finally {
      await close();
    }
  });

  it("identical-content dedup backfills source_log_path via COALESCE when file_path is absent", async () => {
    const { prisma, close } = await openTestPrisma();
    try {
      const first = await upsertPlan(
        prisma,
        makeCapture({
          harness: "claude",
          source: "t8",
          captureMethod: "extractor",
          sessionId: null,
          content: "dedup body 8",
          confidence: 1.0,
        })
      );
      const second = await upsertPlan(
        prisma,
        makeCapture({
          harness: "claude",
          source: "t8",
          captureMethod: "extractor",
          sessionId: null,
          content: "dedup body 8",
          sourceLogPath: "/tmp/log8.jsonl",
          confidence: 1.0,
        })
      );

      expect(second.deduped).toBe(true);
      expect(second.planId).toBe(first.planId);
      const plan = await getPlan(prisma, first.planId);
      expect(plan?.filePath).toBeNull();
      expect(plan?.sourceLogPath).toBe("/tmp/log8.jsonl");
    } finally {
      await close();
    }
  });

  it("empty-string title and capture_method on a raw capture resolve to null after create", async () => {
    const { prisma, close } = await openTestPrisma();
    try {
      const capture = rawCapture({
        source: "t9",
        capture_method: "",
        title: "",
        content_markdown: "raw body content",
        content_sha256: "raw-sha-9",
      });
      const result = await upsertPlan(prisma, capture);
      expect(result.created).toBe(true);

      const plan = await getPlan(prisma, result.planId);
      expect(plan?.title).toBeNull();
      expect(plan?.captureMethod).toBeNull();

      const versions = await getPlanVersions(prisma, result.planId);
      expect(versions[0]?.captureMethod).toBeNull();
    } finally {
      await close();
    }
  });

  it("identical-content dedup backfills file_path via COALESCE when file_path was previously absent", async () => {
    // planKeyFor derives its key differently depending on whether file_path is
    // present, so a plan created WITHOUT file_path and re-submitted WITH one
    // can't naturally dedup-match through upsertPlan alone (the two calls
    // compute different plan_keys). Seed the plan+version directly instead,
    // with a plan_key equal to the basename the file_path capture will derive,
    // and a stored file_path of NULL so findExistingPlan's file_path branch
    // (`file_path = $3 OR file_path IS NULL`) matches it.
    const { db, prisma, close } = await openTestPrisma();
    try {
      const seedContent = "dedup content shared 10b";
      const seedCapture = makeCapture({
        harness: "claude",
        source: "seed",
        captureMethod: "extractor",
        sessionId: null,
        content: seedContent,
        confidence: 1.0,
      });
      await db.query(
        `INSERT INTO plans
           (id, harness, plan_key, file_path, created_from_session_id,
            needs_confirmation, confidence, capture_method, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          "dedup-bare-1",
          "claude",
          "fixed-dedup.md",
          null,
          null,
          false,
          1.0,
          "extractor",
          "2026-01-01T00:00:00.000Z",
        ]
      );
      await db.query(
        `INSERT INTO plan_versions
           (id, plan_id, version_number, content_markdown, content_sha256,
            author_type, capture_method, created_at)
         VALUES ($1, $2, $3, $4, $5, 'agent', 'hook', $6)`,
        [
          "dedup-bare-1-v1",
          "dedup-bare-1",
          1,
          seedContent,
          seedCapture.content_sha256,
          "2026-01-01T00:00:00.000Z",
        ]
      );

      const capture = makeCapture({
        harness: "claude",
        source: "t10b",
        captureMethod: "extractor",
        sessionId: null,
        content: seedContent,
        filePath: "/tmp/fixed-dedup.md",
        confidence: 1.0,
      });
      const result = await upsertPlan(prisma, capture);

      expect(result.deduped).toBe(true);
      expect(result.planId).toBe("dedup-bare-1");
      const plan = await getPlan(prisma, "dedup-bare-1");
      expect(plan?.filePath).toBe("/tmp/fixed-dedup.md");
    } finally {
      await close();
    }
  });

  it("matches an existing plan row that has zero plan_versions rows and creates version 1", async () => {
    const { db, prisma, close } = await openTestPrisma();
    try {
      await db.query(
        `INSERT INTO plans
           (id, harness, plan_key, file_path, created_from_session_id,
            needs_confirmation, confidence, capture_method, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          "bare-1",
          "claude",
          "fixed.md",
          "/tmp/fixed.md",
          null,
          false,
          1.0,
          "extractor",
          "2026-01-01T00:00:00.000Z",
        ]
      );

      const capture = makeCapture({
        harness: "claude",
        source: "t10",
        captureMethod: "extractor",
        sessionId: null,
        content: "brand new content for a versionless plan",
        filePath: "/tmp/fixed.md",
        confidence: 1.0,
      });
      const result = await upsertPlan(prisma, capture);

      expect(result.planId).toBe("bare-1");
      expect(result.created).toBe(false);
      expect(result.deduped).toBe(false);
      expect(result.version).toBe(1);
      expect(result.versionId).not.toBeNull();

      const versions = await getPlanVersions(prisma, "bare-1");
      expect(versions).toHaveLength(1);
      expect(versions[0]?.contentMarkdown).toBe(
        "brand new content for a versionless plan"
      );
    } finally {
      await close();
    }
  });
});

describe("upsertPlanVersion / getPlan / listPlans on a versionless plan", () => {
  it("a plan seeded with zero plan_versions reports null latestContent and 0 versionCount until upsertPlanVersion adds one", async () => {
    const { db, prisma, close } = await openTestPrisma();
    try {
      await db.query(
        `INSERT INTO plans
           (id, harness, plan_key, created_from_session_id,
            needs_confirmation, confidence, capture_method, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          "bare-2",
          "claude",
          "bare-2-key",
          null,
          false,
          1.0,
          "extractor",
          "2026-01-01T00:00:00.000Z",
        ]
      );

      const before = await getPlan(prisma, "bare-2");
      expect(before?.versionCount).toBe(0);
      expect(before?.latestContent).toBeNull();

      const listed = await listPlans(prisma);
      expect(listed.find((p) => p.id === "bare-2")?.versionCount).toBe(0);

      const result = await upsertPlanVersion(prisma, {
        plan_id: "bare-2",
        content_markdown: "first version content",
      });
      expect(result.deduped).toBe(false);
      expect(result.versionNumber).toBe(1);
      expect(result.versionId).not.toBe("");

      const after = await getPlan(prisma, "bare-2");
      expect(after?.versionCount).toBe(1);
      expect(after?.latestContent).toBe("first version content");
    } finally {
      await close();
    }
  });
});
