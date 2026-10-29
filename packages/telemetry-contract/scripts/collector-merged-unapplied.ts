import {
  artifactVendoringDeclared,
  CollectorArtifactVendoring,
  declaredArtifactVendoring,
  isRegisteredArtifact,
} from "./collector-artifact-vendoring";
import {
  type CollectorGuardFinding,
  CollectorVendoringLedgerPath,
  classifyReasonedSubjects,
  isRecord,
  isStringArray,
} from "./collector-codegen-common";

export const MergedUnappliedField = "mergedUnapplied" as const;

const APPLY_HINT = `Remove the entry from "${MergedUnappliedField}" in ${CollectorVendoringLedgerPath} once the apply has landed and a human has re-read the running collector — nothing in this repo can observe that hop (ISS-9694).`;

const SHAPE_HINT = `"${MergedUnappliedField}" maps each subject — an attribute key from "vendoredKeys", or a \`collector/\` artifact path declared "${CollectorArtifactVendoring.Vendored}" in "artifactVendoring" — to a reason naming the infrastructure merge and, REQUIRED and checked, the ticket that owns its apply as an \`ISS-<number>\` reference.`;

/**
 * The declared merged-but-unapplied subjects, or `undefined` when the field is
 * present but malformed.
 *
 * ABSENT is not malformed: the field is optional and an empty overlay is a real
 * state ("everything vendored here is also applied"), and it is the state the
 * committed ledger is in today. Present-but-wrong is a different claim and
 * reports, because a `mergedUnapplied: []` written as an array, or a subject
 * mapped to `null`, would otherwise silently record nothing while reading as a
 * filled-in ledger.
 *
 * An entry whose reason names no apply ticket reports and is DROPPED from the
 * returned map, so it cannot also print an unroutable standing warning: one
 * annotation naming the defect beats two, the second of which sends the reader
 * nowhere.
 */
export function parseMergedUnapplied(
  ledgerSource: string,
  findings: CollectorGuardFinding[]
): ReadonlyMap<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ledgerSource);
  } catch {
    // Silent by design. Both `check-collector-vendoring.ts` and
    // `collector-artifact-vendoring.ts` parse this same file on the same run
    // and each already reports an unparseable ledger; a third identical
    // annotation would read as three separate defects in one broken file.
    return undefined;
  }

  const field = isRecord(parsed) ? parsed[MergedUnappliedField] : undefined;
  if (field === undefined) {
    return new Map();
  }
  if (!isRecord(field)) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `"${MergedUnappliedField}" must be an object, so each merged-but-unapplied subject carries the apply that closes it. ${SHAPE_HINT}`,
    });
    return undefined;
  }

  // The loop and the ticket bar are shared with the other reason-carrying
  // ledger field (whitlockk, #6917). One owner because two copies of a bar are two
  // bars: this tightening landed here and would have had to be remembered again
  // for every later field. What is NOT shared is the policy below — an entry
  // that fails the bar is DROPPED here, so it cannot also print a standing
  // warning that routes nowhere.
  const classified = classifyReasonedSubjects(field);

  if (classified.unreasoned.length > 0) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Merged-but-unapplied subject(s) with no stated reason, so nothing says which apply closes them: ${classified.unreasoned.join(", ")}. ${SHAPE_HINT}`,
    });
  }

  if (classified.unrouted.length > 0) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Merged-but-unapplied subject(s) whose reason names no apply ticket, so the standing warning they print every run routes nowhere: ${classified.unrouted.join(", ")}. ${SHAPE_HINT}`,
    });
  }

  return classified.routed;
}

/**
 * The overlay's one invariant: every subject must be one the ledger declares
 * vendored.
 *
 * Both halves of that are load-bearing, and each catches a different real
 * defect. A subject in neither dimension is a typo or a retired key, and an
 * overlay entry pointing at nothing is precisely the stale sentence this state
 * was added to stop generating. A KEY still sitting in `pendingVendoringKeys`
 * is the sharper one: `pending` means the merged template does NOT carry it,
 * which the overlay says it does, so the ledger would be defining the same word
 * two incompatible ways — the ISS-9809 defect itself, now mechanical rather
 * than a thing a reader has to notice.
 */
export function evaluateMergedUnapplied(
  ledgerSource: string
): CollectorGuardFinding[] {
  const findings: CollectorGuardFinding[] = [];
  const entries = parseMergedUnapplied(ledgerSource, findings);
  if (!entries) {
    return findings;
  }

  // A malformed `vendoredKeys` is already reported by the key guard on the same
  // run; resolving every subject against an empty set here would report the
  // whole overlay a second time as undeclared, which is false and sends the
  // reader to fix the wrong field.
  const vendored = vendoredKeySet(ledgerSource);
  if (!vendored) {
    return findings;
  }

  // Same rule as the `vendoredKeys` guard above, for the other dimension: a
  // malformed `artifactVendoring` makes EVERY artifact read as undeclared, so
  // resolving against it would blame each overlay entry for a defect one field
  // over — which the artifact guard has already reported precisely.
  const artifactsReadable = artifactVendoringDeclared(ledgerSource);
  const undeclared = [...entries.keys()]
    .filter(
      (subject) =>
        !isDeclaredVendored(subject, vendored, {
          artifactsReadable,
          ledgerSource,
        })
    )
    .sort();
  if (undeclared.length > 0) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Merged-but-unapplied subject(s) the ledger does not declare vendored, so this file states the deployed template both carries and lacks them: ${undeclared.join(", ")}. A subject is only "merged, apply queued" once it is in "vendoredKeys" (or "${CollectorArtifactVendoring.Vendored}" in "artifactVendoring") — move it there, or drop the "${MergedUnappliedField}" entry.`,
    });
  }

  return findings;
}

/**
 * The standing warnings, which are the whole point of the state existing.
 *
 * Without a line on every run, a `vendoredKeys` entry whose apply is queued and
 * one that has been live for months print identically — which is the silence
 * the ruling introduced and this state was added to end. A diff is read once;
 * an apply can sit in the ISS-9677 queue for weeks.
 *
 * The wording says the running collector does not carry the CHANGE, never that
 * it lacks the subject. Absence is only the key dimension's shape: an artifact
 * here is typically PRESENT and stale (`tail_sampling` is deployed, running the
 * pre-ISS-9254 policy), so an absence claim would print a permanently-wrong
 * sentence on every run — the defect `$pending` already indicts the parked-key
 * warning for.
 */
export function mergedUnappliedWarnings(ledgerSource: string): string[] {
  const entries = parseMergedUnapplied(ledgerSource, []);
  if (!entries) {
    return [];
  }

  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([subject, reason]) =>
        `Merged into the infrastructure template but NOT yet applied, so the RUNNING collector does not carry this change yet: ${subject}. ${reason} ${APPLY_HINT}`
    );
}

function isDeclaredVendored(
  subject: string,
  vendoredKeys: ReadonlySet<string>,
  artifacts: { artifactsReadable: boolean; ledgerSource: string }
): boolean {
  if (vendoredKeys.has(subject)) {
    return true;
  }
  if (!isRegisteredArtifact(subject)) {
    return false;
  }
  return (
    !artifacts.artifactsReadable ||
    declaredArtifactVendoring(artifacts.ledgerSource, subject) ===
      CollectorArtifactVendoring.Vendored
  );
}

function vendoredKeySet(ledgerSource: string): ReadonlySet<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ledgerSource);
  } catch {
    return undefined;
  }
  const keys = isRecord(parsed) ? parsed.vendoredKeys : undefined;
  return isStringArray(keys) ? new Set(keys) : undefined;
}
