import {
  type CollectorGuardFinding,
  CollectorVendoringLedgerPath,
  classifyReasonedSubjects,
  isRecord,
} from "./collector-codegen-common";

/**
 * ISS-9770: the key dimension's third state.
 *
 * `vendoredKeys` and `pendingVendoringKeys` are two states for three real
 * situations, and the collapsed pair fails in the direction that manufactures
 * obligation: a key with NO producer on the keyless OTLP lane is spelled as one
 * whose vendoring is outstanding, so `check:collector-vendoring` prints, on
 * every run, that it is stripped before reaching Datadog and no dashboard can
 * show it. For `app.client.version` that is false in both halves — the desktop
 * sends it as a request HEADER and cl-api emits the attribute (ISS-8749), so it
 * never passes through the redaction processor this ledger gates, and 77,984
 * log records over the 14 days to 2026-09-08 say the dashboards have it
 * (whitlockk, #6845). A standing warning that is permanently wrong is a warning
 * nobody reads, which is the ISS-8015 silence arriving by a different road.
 *
 * So the state is explicit rather than inferred at a read site: nothing may
 * decide "this one is excluded" from a name pattern or a sentinel, because that
 * moves the bug rather than fixing it. `keylessExcludedKeys` maps each key to
 * the reason it has no keyless producer — REQUIRED, so the state cannot be used
 * to hush a genuinely dark key.
 *
 * `pending` keeps its meaning and therefore its warning: a key named there is
 * work someone owes. `user.id` stays there deliberately — it is not
 * keyless-excluded, it is deferred behind a privacy decision about what an
 * unauthenticated client may put in the KEYLESS span index, and that call is a
 * human's (ISS-9770, ISS-8748).
 */

export const CollectorKeyVendoring = {
  Vendored: "vendored",
  Pending: "pending",
  KeylessExcluded: "keylessExcluded",
} as const;
export type CollectorKeyVendoring =
  (typeof CollectorKeyVendoring)[keyof typeof CollectorKeyVendoring];

/**
 * The ledger field each state is spelled as.
 *
 * Exhaustive like the two maps below, and it exists so no message has to spell
 * a field name by hand: an annotation that names a STATE (`pending`) sends an
 * author grepping the ledger for a word that only appears in `artifactVendoring`,
 * a different dimension entirely.
 */
export const KEY_LEDGER_FIELD: Record<CollectorKeyVendoring, string> = {
  [CollectorKeyVendoring.Vendored]: "vendoredKeys",
  [CollectorKeyVendoring.Pending]: "pendingVendoringKeys",
  [CollectorKeyVendoring.KeylessExcluded]: "keylessExcludedKeys",
};

export const KeylessExcludedField =
  KEY_LEDGER_FIELD[CollectorKeyVendoring.KeylessExcluded];

export type CollectorKeyLedger = {
  /** Each excluded key mapped to the reason it has no keyless producer. */
  keylessExcludedKeys: ReadonlyMap<string, string>;
  pendingVendoringKeys: readonly string[];
  vendoredKeys: readonly string[];
};

/**
 * The keys one state holds, resolved per state rather than per ledger field.
 *
 * Exhaustive by construction, and that is the whole reason it is a `Record` and
 * not a list of the arrays: every other reader here — the undeclared check, the
 * stale check, the duplicate check, the one-state-only check — is derived from
 * this map, so a fourth state cannot be added without a row and fails `tsc`
 * instead of falling through to a default. A `ReadonlySet<string>` of "the
 * fields that count as declared" would compile unchanged and silently treat a
 * new state's keys as undeclared, which is the side-inventory shape this repo
 * has shipped before.
 */
const KEYS_IN_STATE: Record<
  CollectorKeyVendoring,
  (ledger: CollectorKeyLedger) => readonly string[]
> = {
  [CollectorKeyVendoring.Vendored]: (ledger) => ledger.vendoredKeys,
  [CollectorKeyVendoring.Pending]: (ledger) => ledger.pendingVendoringKeys,
  [CollectorKeyVendoring.KeylessExcluded]: (ledger) => [
    ...ledger.keylessExcludedKeys.keys(),
  ],
};

/**
 * The standing warning each state earns, or `undefined` for a state that is
 * settled and says nothing on a run.
 *
 * `keylessExcluded` is silent BY DESIGN and that is the point of the state:
 * excluded work is not outstanding work, so it must never render as a count, a
 * warning, or anything else a reader could mistake for a queue. Its reason is
 * carried in the ledger where a reader who goes looking finds it.
 *
 * The `pending` wording says the KEYLESS lane, not "no dashboard can show
 * them". A parked key can be delivered on another lane — `user.id` arrives on
 * `service:cl-api` logs — so the wider claim was false for the parked set even
 * after the excluded key left it.
 *
 * EACH WARNING CARRIES ITS OWN REMEDY, and that is not tidiness. A shared hint
 * appended to every line named all three states, so the standing warning whose
 * only subject is `user.id` was advertising a move into the silent state — the
 * move this ledger's own prose calls "the ISS-9770 defect running the other
 * way". The next agent clearing a red build takes the remediation the tool
 * offered and quietly closes the ISS-8748 privacy decision. Declaring a key
 * excluded is the remedy for an UNDECLARED key and belongs on that error, which
 * is where `check-collector-vendoring.ts` puts it.
 */
const STANDING_WARNING: Record<
  CollectorKeyVendoring,
  ((keys: readonly string[]) => string) | undefined
> = {
  [CollectorKeyVendoring.Vendored]: undefined,
  [CollectorKeyVendoring.KeylessExcluded]: undefined,
  [CollectorKeyVendoring.Pending]: (keys) =>
    `Telemetry attribute(s) parked ahead of the deployed collector, so an event carrying them on the keyless OTLP lane is stripped before reaching Datadog: ${keys.join(", ")}. Vendor the regenerated \`collector/keyless-telemetry-redaction.yaml\` into infrastructure \`collector/config.yaml\`, then move the key(s) into "${KEY_LEDGER_FIELD[CollectorKeyVendoring.Vendored]}" in ${CollectorVendoringLedgerPath}.`,
};

export const CollectorKeyVendoringStates: readonly CollectorKeyVendoring[] =
  Object.keys(KEYS_IN_STATE) as CollectorKeyVendoring[];

export function keysInState(
  ledger: CollectorKeyLedger,
  state: CollectorKeyVendoring
): readonly string[] {
  return KEYS_IN_STATE[state](ledger);
}

/** Every key the ledger declares, in any state. */
export function declaredKeys(ledger: CollectorKeyLedger): string[] {
  return CollectorKeyVendoringStates.flatMap((state) => [
    ...keysInState(ledger, state),
  ]);
}

/**
 * The warning lines the key dimension owes, one per warning-bearing state.
 *
 * Sorted inside each line so the output is stable, and skipped entirely when a
 * state is empty: a warning naming no key is noise that trains readers past the
 * ones that name some.
 */
export function collectorKeyVendoringWarnings(
  ledger: CollectorKeyLedger
): string[] {
  return CollectorKeyVendoringStates.flatMap((state) => {
    const warn = STANDING_WARNING[state];
    const keys = [...keysInState(ledger, state)].sort();
    return warn && keys.length > 0 ? [warn(keys)] : [];
  });
}

const SHAPE_HINT = `"${KeylessExcludedField}" maps each attribute key with NO producer on the keyless OTLP lane to the reason it has none — which lane carries it instead, and, REQUIRED and checked, the \`ISS-<number>\` that established that.`;

/**
 * The excluded keys and their reasons, or `undefined` when the field is present
 * but malformed.
 *
 * Takes the ALREADY-PARSED ledger. Both callers parse this same source and bail
 * before reaching here, so a second `JSON.parse` and the catch branch under it
 * were unreachable — and a comment explaining why that branch stayed silent was
 * explaining a branch that could not run.
 *
 * ABSENT is not malformed: the field is optional, an empty exclusion set is a
 * real state, and a ledger written before ISS-9770 still parses. Present but not
 * an object IS a different claim and reports, because `keylessExcludedKeys: []`
 * would otherwise record nothing while reading as a filled-in ledger.
 *
 * A bad reason reports AND the entry stays in the map. The finding already fails
 * the run, and dropping it would report the same key a second time as
 * undeclared — one annotation naming the defect beats two, the second of which
 * sends the reader to the wrong field. That is the opposite of
 * `mergedUnapplied`'s choice for the same shape, deliberately: dropping an entry
 * there suppresses a standing warning that would route nowhere, and there is no
 * warning here to suppress.
 *
 * THE REASON MUST NAME A TICKET, which is whitlockk's #6917 bar on `mergedUnapplied`
 * applied rather than re-decided. Non-blank was the whole contract there until
 * `waiting` was shown to pass it, and the argument transfers with more force
 * here: this state prints NOTHING on any run, so `"n/a"` would permanently hush
 * a key that may be genuinely dark. What the ticket owns differs — there it is
 * the apply that ENDS the state, here it is the measurement that established
 * which lane carries the key — but in both it is the half a reader challenging
 * the entry can actually go and read.
 */
export function parseKeylessExcluded(
  ledger: Record<string, unknown>,
  findings: CollectorGuardFinding[]
): ReadonlyMap<string, string> | undefined {
  const field = ledger[KeylessExcludedField];
  if (field === undefined) {
    return new Map();
  }
  if (!isRecord(field)) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `"${KeylessExcludedField}" must be an object, so each excluded key carries its reason. ${SHAPE_HINT}`,
    });
    return undefined;
  }

  const classified = classifyReasonedSubjects(field);

  if (classified.unreasoned.length > 0) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Keyless-excluded key(s) with no stated reason, so nothing says why the redaction allow-list is not where they live: ${classified.unreasoned.join(", ")}. ${SHAPE_HINT}`,
    });
  }

  if (classified.unrouted.length > 0) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Keyless-excluded key(s) whose reason names no ticket, so a reader who doubts the exclusion has nowhere to go — and this state prints nothing on any run, so nothing else will ever raise it: ${classified.unrouted.join(", ")}. ${SHAPE_HINT}`,
    });
  }

  return classified.all;
}
