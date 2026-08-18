/**
 * @file local-insights-prose-population.test.ts
 * @description ISS-5828 — local Insights has no account-scoped default-branch
 * authority, so it withholds branch coverage instead of approximating it from
 * raw artifact names, including prose-only evidence.
 *
 * These live in their own file rather than in `local-insights-contract.test.ts`
 * because that file is in the shrink-only grandfather list in `biome.jsonc`.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

process.env.TZ = "America/Chicago";

const NOW = new Date("2026-06-22T00:00:00.000Z");
const SESSION_ENDED_AT = "2026-06-20T00:00:00.000Z";
const REPO = "org/repo";

type SeedLink = {
  linkId: string;
  artifactId: string;
  method: string;
  relation: string;
};

async function seedBranchWithLinks(
  db: Awaited<ReturnType<typeof openInsightsDb>>["db"],
  branchName: string,
  links: readonly SeedLink[]
): Promise<void> {
  const artifactId = links[0]?.artifactId ?? branchName;
  await db.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name,
        created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
    [
      artifactId,
      `branch:prose:${branchName}`,
      REPO,
      branchName,
      SESSION_ENDED_AT,
    ]
  );
  for (const link of links) {
    await db.query(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ($1, 'prose-sess', $2, $3, $4, '{}', 1, $5, $5)`,
      [
        link.linkId,
        link.artifactId,
        link.relation,
        link.method,
        SESSION_ENDED_AT,
      ]
    );
  }
}

test("ISS-5828: local branch coverage stays unavailable for raw prose and write evidence", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-prose-");
  try {
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $3)",
      ["prose-sess", "completed", SESSION_ENDED_AT]
    );

    // A branch the session actually WORKED on — command evidence, no PR. This
    // is the row that must survive, so the assertion cannot pass by the donut
    // simply being empty.
    await seedBranchWithLinks(db, "feat/worked", [
      {
        linkId: "link-worked",
        artifactId: "art-worked",
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Created,
      },
    ]);
    // A branch whose ONLY evidence is a prose mention. Must not be counted.
    await seedBranchWithLinks(db, "feat/only-mentioned", [
      {
        linkId: "link-mentioned",
        artifactId: "art-mentioned",
        method: ArtifactRefMethod.BranchMentionInProse,
        relation: ArtifactRefRelation.Referenced,
      },
    ]);
    // A branch carrying BOTH a command ref and a prose mention. The gate keys
    // on "nothing but non-delivery evidence", so this one must still count —
    // otherwise the fix would delete real branches that were also talked about.
    await seedBranchWithLinks(db, "feat/worked-and-mentioned", [
      {
        linkId: "link-both-cmd",
        artifactId: "art-both",
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Created,
      },
      {
        linkId: "link-both-prose",
        artifactId: "art-both",
        method: ArtifactRefMethod.BranchMentionInProse,
        relation: ArtifactRefRelation.Referenced,
      },
    ]);

    const all = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.All,
      NOW
    );

    assert.deepEqual(all.charts.branchesWithoutPr, []);
    assert.equal(
      all.tileAvailability?.["chart:branchesWithoutPr"],
      "unavailable"
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
