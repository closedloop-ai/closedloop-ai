/**
 * FEA-3597 Phase 7b — the ruling's §3 PRIMARY IDENTITY, run against the REAL
 * parser and the REAL `deriveSessionTurnBuckets`.
 *
 *   Σ agent bucket units == count of PARENT-attributed tokenSeries entries
 *                           with a valid timestamp
 *
 * Sessions are RE-PARSED from each dossier's frozen `raw/` via the production
 * parser — NOT read from `normalized.json`. That distinction is the whole
 * point: the frozen L1 oracles are pre-marker, so reading them back would show
 * every folded subagent record as parent and reproduce the Option A numbers.
 * The marker exists only at parse time, which is exactly why this change needs
 * a DATA_REVISION rebuild.
 *
 * HARD STOPS (park, do not regenerate golden): the identity fails on any
 * dossier; human bucket rows change; the dossier set changes.
 *
 * Throwaway probe — not part of the suite. Run from apps/desktop:
 *   pnpm exec tsx scripts/fea3597-identity-probe.mts
 */
import { deriveSessionTurnBuckets } from "../src/main/database/turn-buckets.js";
import {
  discoverDossiers,
  parseDossierRaw,
} from "../test/golden/golden-corpus.js";
import { oldRule, rulingFlag } from "./fea3597-identity-probe-lib.js";

const EXPECTED_CORPUS_SIZE = 26;

let identityFailures = 0;
let humanChanges = 0;
let nullParses = 0;
let rulingMismatches = 0;
let dossiers = 0;
let oldAgentTotal = 0;
let newAgentTotal = 0;
let oldHumanTotal = 0;
let newHumanTotal = 0;
let markedTotal = 0;

console.log(
  "dossier   agentOLD agentNEW  parentEntries marked  identity  human?  ruling"
);

for (const d of discoverDossiers()) {
  if (d.normalized === null) {
    continue;
  }
  const parsed = await parseDossierRaw(d);
  if (parsed === null) {
    console.log(`${d.sessionId.slice(0, 8)}  PARSER RETURNED NULL — FAIL`);
    nullParses += 1;
    continue;
  }
  dossiers += 1;
  // Round-trip through the serialized form rather than casting the parser's
  // object: `deriveSessionTurnBuckets` reads the stored metadata TEXT, so this
  // measures the production path instead of a differently-typed view of it.
  const metadataText = JSON.stringify(parsed);
  const meta: Record<string, unknown> = JSON.parse(metadataText);

  const rows = deriveSessionTurnBuckets(d.sessionId, metadataText);
  const newAgent = rows
    .filter((r) => r.turnKind === "agent")
    .reduce((a, r) => a + r.turnCount, 0);
  const newHuman = rows
    .filter((r) => r.turnKind === "human")
    .reduce((a, r) => a + r.turnCount, 0);
  const old = oldRule(meta);

  const series = Array.isArray(meta.tokenSeries) ? meta.tokenSeries : [];
  let marked = 0;
  const parentEntries = series.filter((e) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      return false;
    }
    const r = e as { subagentId?: unknown; timestamp?: unknown };
    if (r.subagentId !== undefined) {
      marked += 1;
      return false;
    }
    return (
      typeof r.timestamp === "string" &&
      Number.isFinite(Date.parse(r.timestamp))
    );
  }).length;
  markedTotal += marked;

  const identityOk = newAgent === parentEntries;
  const humanOk = newHuman === old.human;
  if (!identityOk) {
    identityFailures += 1;
  }
  if (!humanOk) {
    humanChanges += 1;
  }

  oldAgentTotal += old.agent;
  newAgentTotal += newAgent;
  oldHumanTotal += old.human;
  newHumanTotal += newHuman;

  const short = d.sessionId.slice(0, 8);
  const ruling = rulingFlag(short, newAgent);
  if (ruling.mismatch) {
    rulingMismatches += 1;
  }
  console.log(
    `${short.padEnd(9)} ${String(old.agent).padStart(8)} ${String(newAgent).padStart(8)} ${String(parentEntries).padStart(14)} ${String(marked).padStart(6)}  ${(identityOk ? "OK" : "**FAIL**").padStart(8)}  ${humanOk ? "same" : "**CHANGED**"}${ruling.label}`
  );
}

console.log(`\ndossiers: ${dossiers} (expected ${EXPECTED_CORPUS_SIZE})`);
console.log(`null parses: ${nullParses}`);
console.log(`agent units: ${oldAgentTotal} -> ${newAgentTotal}`);
console.log(`human units: ${oldHumanTotal} -> ${newHumanTotal}`);
console.log(`records carrying a subagentId marker: ${markedTotal}`);
console.log(`identity failures: ${identityFailures}`);
console.log(`human-row changes: ${humanChanges}`);
console.log(`ruling mismatches: ${rulingMismatches}`);

const failures =
  identityFailures + humanChanges + nullParses + rulingMismatches;
if (dossiers !== EXPECTED_CORPUS_SIZE) {
  console.error(
    `\n§3 HARD STOP — corpus size ${dossiers} != expected ${EXPECTED_CORPUS_SIZE}.`
  );
  process.exit(1);
}
if (failures > 0) {
  console.error("\n§3 HARD STOP — do not regenerate golden.");
  process.exit(1);
}
console.log(
  "\n§3 primary identity holds on every dossier; human rows unchanged."
);
