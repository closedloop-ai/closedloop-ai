/**
 * @file golden-sync-fixture-data-revision.test.ts
 * @description ISS-4754 / ISS-7165 — the derived golden sync fixtures must be
 * stamped with the CURRENT attribution revision.
 *
 * ISS-7165's evidence: the single committed fixture sat at `dataRevision: 81`
 * while the constant had moved to 82, then 83, and nothing went red — the only
 * suite that read it is `describeIfDb`-gated, so it simply did not run. A
 * derived artifact that silently stops tracking its source is the exact failure
 * the golden charter names as the one that actually bites.
 *
 * The fixtures are produced with the attribution parse policy on (ISS-12552,
 * PRD-800 "Rollout"), so they carry `DATA_REVISION_ATTRIBUTION`.
 *
 * This test lives in the DESKTOP node lane because that is where the revision
 * is defined; it needs no database, so it cannot be skipped into a false green
 * the way the DB-gated parity suite can. It compares against the CONSTANT, never
 * a copied literal, so bumping the revision cannot leave this assertion stale.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { DATA_REVISION_ATTRIBUTION } from "../src/main/collectors/engine/data-revision.js";

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/api/__tests__/fixtures/golden-web-sync"
);
const FIXTURE_SUFFIX = ".synced-session.json";

type FixtureSession = { dataRevision?: number | null };
type Fixture = {
  kind?: string;
  sessions?: FixtureSession[];
  chunks?: FixtureSession[];
};

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(FIXTURE_SUFFIX))
    .sort();
}

function sessionsOf(fixture: Fixture): FixtureSession[] {
  return fixture.kind === "chunked"
    ? (fixture.chunks ?? [])
    : (fixture.sessions ?? []);
}

describe("golden sync fixtures track the attribution revision (ISS-7165)", () => {
  test("the corpus produced fixtures at all, so the sweep below is not vacuous", () => {
    assert.ok(
      fixtureFiles().length > 0,
      `no ${FIXTURE_SUFFIX} fixtures under ${FIXTURES_DIR} — regenerate with \`pnpm --filter desktop run regen:golden-sync-payloads\``
    );
  });

  test("every session in every fixture is stamped with the current attribution revision", () => {
    const stale: string[] = [];
    for (const name of fixtureFiles()) {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURES_DIR, name), "utf8")
      ) as Fixture;
      const sessions = sessionsOf(fixture);
      assert.ok(
        sessions.length > 0,
        `${name}: carries no sessions, so its revision stamp cannot be checked`
      );
      for (const [index, session] of sessions.entries()) {
        if (session.dataRevision !== DATA_REVISION_ATTRIBUTION) {
          stale.push(
            `${name}[${index}]: dataRevision ${String(session.dataRevision)} != DATA_REVISION_ATTRIBUTION ${DATA_REVISION_ATTRIBUTION}`
          );
        }
      }
    }
    assert.deepEqual(
      stale,
      [],
      `${stale.length} fixture session(s) are stale against DATA_REVISION_ATTRIBUTION ${DATA_REVISION_ATTRIBUTION}. Regenerate with \`pnpm --filter desktop run regen:golden-sync-payloads\` and review the diff.`
    );
  });
});
