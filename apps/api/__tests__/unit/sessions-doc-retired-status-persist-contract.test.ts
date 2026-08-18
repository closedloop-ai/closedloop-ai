/**
 * Drift guard (ISS-6037) for the retired-status paragraph of the published
 * Sessions mechanism page.
 *
 * `apps/web/content/docs/mechanisms/sessions.mdx` is the public contract API and
 * MCP consumers read to decide what a `status` read may return. Before ISS-5648
 * it truthfully said a version-skewed client's `completed`/`abandoned` write was
 * "stored verbatim". ISS-5648 folded that pair through
 * `normalizeSessionStatus` at cloud ingest, and the prose was not
 * updated with it — nothing compared the two, so the page kept publishing a
 * write-side contract the server no longer honours.
 *
 * The `.mdx` is prose, so this reads it as data (not a TypeScript source scan)
 * and pins the two halves that can rot apart from the SSOT:
 *   1. every spelling the persist fold REWRITES is named, and one AFFIRMATIVE
 *      clause states that ingest folds that spelling onto the value the SSOT
 *      actually resolves it to — clause, not sentence, and affirmative, not
 *      merely token-bearing, because every retired spelling folds onto the same
 *      `inactive`: a bare token scan let one sentence about the existing pair
 *      vouch for a future third spelling, and let a sentence *denying* the fold
 *      vouch for the fold;
 *   2. every verbatim-storage claim in that paragraph narrows itself off the
 *      folded pair — the fold is deliberately narrow, so a claim scoped to "any
 *      other" value stays true and must stay documented, but an unqualified
 *      "accepted and stored verbatim" is the falsified claim.
 *
 * Retiring a THIRD status fails (1) until the page documents it.
 *
 * `api#test` declares this page in its `turbo.json` inputs, the way `mcp#test`
 * declares its own doc page: without that, reverting the paragraph hashes to the
 * same task key and the cached green result publishes the falsified claim again.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isDisplayOnlySessionStatus,
  normalizeSessionStatus,
  RECOGNIZED_SESSION_STATUS_VALUES,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const sessionsDocPath = path.join(
  repoRoot,
  "apps/web/content/docs/mechanisms/sessions.mdx"
);
const sessionsDoc = readFileSync(sessionsDocPath, "utf8");

/**
 * ISS-5981 (wongk, #5018): every spelling a PRODUCER can send that the persist
 * fold rewrites — not just the retired pair. Scoping the two predicates below to
 * the retired pair alone left the page free to drop its `waiting` /
 * `running` / `failed` mappings with the guard still green, which is the same
 * silent-publication failure ISS-6037 added this file to stop.
 *
 * DERIVED from the SSOT rather than restated, so a new spelling is covered the
 * moment the fold learns it. Display-only members are excluded:
 * `unknown`/`stale` are read-time derivations no producer sends, so the write
 * contract has nothing to say about them.
 */
const PRODUCER_FOLDED_SPELLINGS = RECOGNIZED_SESSION_STATUS_VALUES.filter(
  (status) =>
    normalizeSessionStatus(status) !== status &&
    !isDisplayOnlySessionStatus(status)
);

/**
 * Spellings this build has retired. Held EXPLICITLY, not derived from the fold:
 * the whole point is to catch a page still advertising one of these, and a set
 * derived from the fold would shrink out from under the check exactly when a
 * spelling is retired (wongk/#5120 — how `failed -> error` stayed published).
 */
const RETIRED_SPELLINGS = ["running", "failed", "completed", "abandoned"];

/** The bolded lead of the paragraph that owns the retired pair. */
const RETIRED_PARAGRAPH_LEAD = "were retired.";
/**
 * Sentence-ish split: prose periods plus the semicolons this page clauses on.
 * The semicolons matter — the page joins several independent write-contract
 * claims into one period-delimited sentence, and without splitting them a
 * neighbouring clause's "folded" would vouch for a claim that never narrowed
 * itself.
 */
const SENTENCE_BOUNDARY = /(?<=\.)\s+|;\s+/;
/** A claim that the column keeps what the client sent. */
const STORAGE_CLAIM = /verbatim|persists it/i;
/**
 * The two ways a storage claim can honestly exclude the folded pair: naming the
 * fold, or scoping itself to the residual set the fold leaves alone.
 */
const NARROWED_CLAIM = /fold|(?:any|every) other/i;
/**
 * The fold verb in its AFFIRMATIVE inflection. English do-support forces the
 * bare `fold` under negation ("does not fold"), so requiring the `-s` form is
 * what stops a sentence that denies the fold from vouching for it; the residual
 * adverbial negators ("never folds") are caught by {@link CLAUSE_NEGATOR}.
 */
const AFFIRMATIVE_FOLD_VERB = /\bfolds\b/i;
/** Clause punctuation — the fold verb's own clause starts after the last one. */
const CLAUSE_BREAK = /[:,;—–]/;
/** A word in the run-up to the verb that would flip the clause into a denial. */
const CLAUSE_NEGATOR = /\b(?:not|never|no|nor|neither|rather)\b/i;
const INGEST_MENTION = /ingest/i;

const retiredParagraphs = sessionsDoc
  .split("\n")
  .filter(
    (line) =>
      line.includes(RETIRED_PARAGRAPH_LEAD) &&
      ["completed", "abandoned"].every((status) =>
        line.includes(`\`${status}\``)
      )
  );
const retiredParagraph = retiredParagraphs.join("\n");
const sentences = retiredParagraph.split(SENTENCE_BOUNDARY);

describe("sessions.mdx retired-status persistence contract (ISS-6037)", () => {
  it("has exactly one paragraph owning the retired pair", () => {
    expect(retiredParagraphs).toHaveLength(1);
  });

  it("names every spelling the persist fold rewrites", () => {
    // ISS-5592 emptied the aliases, so the old `> ["completed","abandoned"].length`
    // bound is dead — it was a proxy for "the fold rewrites more than the retired
    // pair", and after the alias removal only `waiting` is left. A bare non-empty
    // check replaces it: the set must never be EMPTY (that would make the loop
    // below vacuous and the guard silent), but its size is now the fold's business.
    expect(PRODUCER_FOLDED_SPELLINGS.length).toBeGreaterThan(0);
    for (const status of PRODUCER_FOLDED_SPELLINGS) {
      expect(normalizeSessionStatus(status)).not.toBe(status);
      expect(retiredParagraph).toContain(`\`${status}\``);
    }
  });

  it("does not publish a fold for a spelling the build no longer folds", () => {
    // The gap the shrinking set left (wongk/#5120 review): the loop above only
    // walks spellings the CURRENT fold rewrites, so a page still advertising a
    // RETIRED spelling's old mapping falls outside it entirely — which is how
    // `failed -> error` stayed published after ISS-5592 stopped performing it.
    // Walk the other direction: anything named in an affirmative fold clause
    // must actually be folded.
    // Reuses `statesIngestFold`, which already scopes the fold verb to its own
    // clause and rejects a denial ("NO LONGER folds `completed`") — the exact
    // shape a naive /\bfolds\b/ scan mistakes for a claim.
    for (const sentence of sentences) {
      for (const status of RETIRED_SPELLINGS) {
        for (const target of Object.values(SESSION_STATUS)) {
          if (!statesIngestFold(sentence, status, target)) {
            continue;
          }
          expect(
            normalizeSessionStatus(status),
            `sessions.mdx states an ingest fold \`${status}\` -> \`${target}\`, which this build does not perform: "${sentence.trim()}"`
          ).toBe(target);
        }
      }
    }
  });

  it("states the ingest fold onto the value the SSOT resolves each spelling to", () => {
    for (const status of PRODUCER_FOLDED_SPELLINGS) {
      const target = normalizeSessionStatus(status);
      const statesFold = sentences.some((sentence) =>
        statesIngestFold(sentence, status, target)
      );
      expect(statesFold).toBe(true);
    }
  });

  it("narrows every verbatim-storage claim off the folded pair", () => {
    const storageClaims = sentences.filter((sentence) =>
      STORAGE_CLAIM.test(sentence)
    );
    expect(storageClaims.length).toBeGreaterThan(0);
    for (const claim of storageClaims) {
      expect(claim).toMatch(NARROWED_CLAIM);
    }
  });
});

/**
 * Whether `sentence` AFFIRMATIVELY states that ingest folds `status` onto
 * `target` — both spellings inside the fold verb's own clause, and no negator
 * leading into that verb.
 *
 * Both narrowings are load-bearing. Token presence anywhere in the sentence let
 * "cloud ingest does not fold `completed` to `inactive`" satisfy the very claim
 * it contradicts; and because every retired spelling folds onto the same
 * `inactive`, a target-only match let the sentence documenting today's pair
 * vouch for a third spelling nobody had documented yet.
 */
function statesIngestFold(
  sentence: string,
  status: string,
  target: string
): boolean {
  if (!INGEST_MENTION.test(sentence)) {
    return false;
  }
  const verb = AFFIRMATIVE_FOLD_VERB.exec(sentence);
  if (!verb) {
    return false;
  }
  const leadIn = sentence.slice(0, verb.index).split(CLAUSE_BREAK).at(-1) ?? "";
  if (CLAUSE_NEGATOR.test(leadIn)) {
    return false;
  }
  const clause = sentence.slice(verb.index);
  return clause.includes(`\`${status}\``) && clause.includes(`\`${target}\``);
}
