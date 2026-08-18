/**
 * @file derive-fea3597-oracle-amendments.ts
 * @description FEA-3597 Layer-1 oracle amendment PROPOSAL generator
 * (agent-generated, HUMAN-applied — this tool never writes into
 * packages/golden-sessions; it refuses an output dir inside the corpus).
 *
 * Recipe per the golden regen chain, identical in shape to the FEA-3419
 * generator it is modelled on: temp-copy raw/ (inside parseDossierRaw), run the
 * PRODUCTION parser, project through the SAME `jsonNormalize` the Layer-1
 * deep-equal uses (so compare semantics and proposals can never drift),
 * preserve the frozen capture-time `fileModifiedAt`, serialize with plain
 * JSON.stringify(,,2).
 *
 * Every proposal is VERIFIED to differ from the frozen oracle in exactly ONE
 * field — `subagentId` added to `tokenSeries[]` records that a subagent
 * round-trip produced — and the run FAILS if any other semantic difference
 * appears, so a proposal can never smuggle an unrelated change past the gate.
 *
 * Why that single-field proof matters more than usual here: FEA-3597 is a
 * PARSER change, and the failure mode it must rule out is a parser regression
 * being laundered into the oracle. Stripping `subagentId` from both sides and
 * demanding the remainder deep-equal means every OTHER value the parser emits —
 * token counts, costs, timestamps, message bodies, subagent structure — is
 * proven byte-identical to the frozen capture. A regression anywhere else in
 * the parser makes this script exit 1 rather than write a proposal.
 *
 * Usage:
 *   pnpm exec tsx test/golden/derive-fea3597-oracle-amendments.ts --output <dir>
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
    "usage: derive-fea3597-oracle-amendments.ts --output <dir> (must be OUTSIDE packages/golden-sessions)"
  );
}
const OUT_DIR = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);
const GOLDEN_CORPUS_DIR = fileURLToPath(
  new URL("../../../../packages/golden-sessions", import.meta.url)
);
assertProposalOutputRoot(OUT_DIR, GOLDEN_CORPUS_DIR);

type Rec = Record<string, unknown>;

/**
 * Strip the FEA-3597 delta from BOTH sides so the remainder must deep-equal.
 *
 * Applied to the root node AND to each `subagents[]` entry, because the root
 * and subagent `tokenSeries` arrays alias the SAME record objects — the marker
 * is visible through both views and has to be removed from both.
 */
function withoutFea3597Fields(value: Rec): Rec {
  const stripNode = (node: Rec): Rec => {
    const next: Rec = { ...node };
    if (Array.isArray(next.tokenSeries)) {
      next.tokenSeries = (next.tokenSeries as Rec[]).map((record) => {
        const { subagentId: _marker, ...rest } = record;
        return rest;
      });
    }
    return next;
  };
  const clone = stripNode(JSON.parse(JSON.stringify(value)) as Rec);
  if (Array.isArray(clone.subagents)) {
    clone.subagents = (clone.subagents as Rec[]).map(stripNode);
  }
  return clone;
}

/**
 * Re-serialize `parsed` using the FROZEN oracle's key order wherever a key
 * exists on both sides, appending genuinely-new keys (i.e. `subagentId`) last.
 *
 * Why this exists: the frozen oracle carries a key order the current parser no
 * longer emits — `providerToolUseId` sits after `resultTimestamp` in the
 * capture but is assigned before `output` today. That is PRE-EXISTING
 * serialization drift, invisible to the Layer-1 test because its compare is
 * `isDeepStrictEqual`, which ignores object key order. Serializing the parser's
 * objects wholesale would therefore bundle a ~6k-line repo-wide key-order
 * rewrite into a signed-oracle amendment, where 62% of the diff had nothing to
 * do with this ticket. A reviewer cannot meaningfully sign that, and burying an
 * unrelated rewrite inside an oracle amendment is exactly what the
 * anti-laundering discipline exists to stop.
 *
 * Values always come from `parsed` — this reorders keys, it never substitutes
 * frozen values for parsed ones. That is sound precisely because the exactness
 * proof above already established the two sides are deep-equal outside
 * `subagentId`, so key order is the only remaining degree of freedom.
 *
 * Arrays are walked positionally rather than reordered: `isDeepStrictEqual` IS
 * order-sensitive for arrays, so array order is already proven identical.
 */
function withOracleKeyOrder(parsed: unknown, oracle: unknown): unknown {
  if (Array.isArray(parsed)) {
    const oracleItems = Array.isArray(oracle) ? oracle : [];
    return parsed.map((item, index) =>
      withOracleKeyOrder(item, oracleItems[index])
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return parsed;
  }
  const parsedRec = parsed as Rec;
  const oracleRec =
    oracle !== null && typeof oracle === "object" && !Array.isArray(oracle)
      ? (oracle as Rec)
      : {};
  const out: Rec = {};
  for (const key of Object.keys(oracleRec)) {
    if (key in parsedRec) {
      out[key] = withOracleKeyOrder(parsedRec[key], oracleRec[key]);
    }
  }
  for (const key of Object.keys(parsedRec)) {
    if (!(key in out)) {
      out[key] = withOracleKeyOrder(parsedRec[key], undefined);
    }
  }
  return out;
}

/** Count marked records on the root series — the number reported per proposal. */
function countMarked(value: Rec): number {
  if (!Array.isArray(value.tokenSeries)) {
    return 0;
  }
  return (value.tokenSeries as Rec[]).filter(
    (record) => record.subagentId !== undefined
  ).length;
}

let proposals = 0;
let unchanged = 0;
let failures = 0;
let totalMarked = 0;
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

  // Exactness proof: outside `subagentId`, the proposal must equal the frozen
  // oracle semantically. This is the anti-laundering gate.
  if (
    !isDeepStrictEqual(
      withoutFea3597Fields(parsed),
      withoutFea3597Fields(d.normalized)
    )
  ) {
    failures += 1;
    console.error(
      `UNEXPECTED NON-FEA-3597 DIFFERENCE (manual review): ${d.sessionId}`
    );
    continue;
  }
  if (isDeepStrictEqual(parsed, d.normalized)) {
    unchanged += 1;
    continue;
  }
  const ordered = withOracleKeyOrder(parsed, d.normalized) as Rec;
  // Reordering must not have changed meaning: same deep-equality, same marker
  // count. Cheap, and it makes the reorder itself non-load-bearing.
  if (!isDeepStrictEqual(ordered, parsed)) {
    failures += 1;
    console.error(`KEY-ORDER PASS ALTERED SEMANTICS (bug): ${d.sessionId}`);
    continue;
  }
  writeOracleProposal({
    outputRoot: OUT_DIR,
    corpusRoot: GOLDEN_CORPUS_DIR,
    sessionId: d.sessionId,
    contents: `${JSON.stringify(ordered, null, 2)}\n`,
  });
  const marked = countMarked(ordered);
  totalMarked += marked;
  console.log(`proposal: ${d.sessionId} (${marked} subagent-marked record(s))`);
  proposals += 1;
}
console.log(
  `\ndone: ${proposals} proposal(s), ${unchanged} unchanged, ${failures} failure(s), ${totalMarked} marked record(s)`
);
if (failures > 0) {
  process.exit(1);
}
