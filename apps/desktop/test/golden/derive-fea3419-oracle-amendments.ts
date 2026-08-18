/**
 * @file derive-fea3419-oracle-amendments.ts
 * @description FEA-3419 Layer-1 oracle amendment PROPOSAL generator
 * (agent-generated, HUMAN-applied — this tool never writes into
 * packages/golden-sessions; it refuses an output dir inside the corpus).
 *
 * Recipe per the golden regen chain: temp-copy raw/ (inside parseDossierRaw),
 * run the PRODUCTION parser, project through the SAME `jsonNormalize` the
 * Layer-1 deep-equal uses (so compare semantics and proposals can never
 * drift), preserve the frozen capture-time `fileModifiedAt`, serialize with
 * plain JSON.stringify(,,2).
 *
 * Every proposal is VERIFIED to differ from the frozen oracle in exactly the
 * FEA-3419 fields — `usageExtras.cache_creation` removed, `cacheWriteTtl`
 * added on tokensByModel/tokenSeries (main + subagents) — and the run FAILS if
 * any other semantic difference appears, so a proposal can never smuggle an
 * unrelated change past the human gate.
 *
 * Usage:
 *   pnpm exec tsx test/golden/derive-fea3419-oracle-amendments.ts --output <dir>
 */
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  assertProposalOutputRoot,
  writeOracleProposal,
} from "./fea3419-oracle-output.js";
import {
  discoverDossiers,
  jsonNormalize,
  parseDossierRaw,
} from "./golden-corpus.js";

const outFlagIndex = process.argv.indexOf("--output");
const outArg = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : undefined;
if (!outArg) {
  throw new Error(
    "usage: derive-fea3419-oracle-amendments.ts --output <dir> (must be OUTSIDE packages/golden-sessions)"
  );
}
const OUT_DIR = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
const GOLDEN_CORPUS_DIR = fileURLToPath(
  new URL("../../../../packages/golden-sessions", import.meta.url)
);
assertProposalOutputRoot(OUT_DIR, GOLDEN_CORPUS_DIR);

type Rec = Record<string, unknown>;

/** Strip the FEA-3419 deltas from BOTH sides so the remainder must deep-equal. */
function withoutFea3419Fields(value: Rec): Rec {
  const stripNode = (node: Rec): Rec => {
    const next: Rec = { ...node };
    if (next.tokensByModel && typeof next.tokensByModel === "object") {
      next.tokensByModel = Object.fromEntries(
        Object.entries(next.tokensByModel as Record<string, Rec>).map(
          ([model, counts]) => {
            const { cacheWriteTtl: _ttl, ...rest } = counts;
            return [model, rest];
          }
        )
      );
    }
    if (Array.isArray(next.tokenSeries)) {
      next.tokenSeries = (next.tokenSeries as Rec[]).map((record) => {
        const { cacheWriteTtl: _ttl, ...rest } = record;
        return rest;
      });
    }
    return next;
  };
  const clone = stripNode(JSON.parse(JSON.stringify(value)) as Rec);
  if (clone.usageExtras && typeof clone.usageExtras === "object") {
    const { cache_creation: _blob, ...usageExtrasRest } =
      clone.usageExtras as Rec;
    clone.usageExtras = usageExtrasRest;
  }
  if (Array.isArray(clone.subagents)) {
    clone.subagents = (clone.subagents as Rec[]).map(stripNode);
  }
  return clone;
}

let proposals = 0;
let unchanged = 0;
let failures = 0;
for (const d of discoverDossiers()) {
  if (d.normalized === null) {
    unchanged += 1;
    continue;
  }
  const parsed = jsonNormalize(await parseDossierRaw(d));
  if (parsed === null) {
    failures += 1;
    console.error(`PARSER EMITTED NULL (manual review): ${d.sessionId}`);
    continue;
  }
  // Preserve the frozen capture-time mtime (jsonNormalize nulls it).
  parsed.fileModifiedAt = d.normalized.fileModifiedAt ?? null;
  // Preserve the oracle's `plans: []` spelling where it exists: jsonNormalize
  // DROPS an empty plans array on the parse side (FEA-3553 — the Layer-1
  // compare mirrors the drop on the oracle side via projectOracle), but a
  // proposal must not silently delete a key the frozen oracle carries.
  if (
    Array.isArray(d.normalized.plans) &&
    d.normalized.plans.length === 0 &&
    !("plans" in parsed)
  ) {
    parsed.plans = [];
  }

  // Exactness proof: outside the FEA-3419 fields, proposal must equal the
  // frozen oracle byte-for-byte semantically.
  if (
    !isDeepStrictEqual(
      withoutFea3419Fields(parsed),
      withoutFea3419Fields(d.normalized)
    )
  ) {
    failures += 1;
    console.error(
      `UNEXPECTED NON-FEA-3419 DIFFERENCE (manual review): ${d.sessionId}`
    );
    continue;
  }
  if (isDeepStrictEqual(parsed, d.normalized)) {
    unchanged += 1;
    continue;
  }
  writeOracleProposal({
    outputRoot: OUT_DIR,
    corpusRoot: GOLDEN_CORPUS_DIR,
    sessionId: d.sessionId,
    contents: `${JSON.stringify(parsed, null, 2)}\n`,
  });
  const usageExtras = d.normalized.usageExtras as Rec | undefined;
  const hadBlob = usageExtras ? "cache_creation" in usageExtras : false;
  console.log(
    `proposal: ${d.sessionId} (blob removed: ${hadBlob}; cacheWriteTtl added where reported)`
  );
  proposals += 1;
}
console.log(
  `\ndone: ${proposals} proposal(s), ${unchanged} unchanged, ${failures} failure(s)`
);
if (failures > 0) {
  process.exit(1);
}
