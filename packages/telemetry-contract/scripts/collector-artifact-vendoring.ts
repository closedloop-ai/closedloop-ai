import {
  type CollectorGuardFinding,
  CollectorVendoringLedgerPath,
  describeError,
  diffFindings,
  isRecord,
} from "./collector-codegen-common";

/**
 * Every artifact the collector generators emit, written out by hand.
 *
 * Deliberately NOT derived from the generators' own path constants. A registry
 * computed from the thing it polices cannot detect drift in it: regenerating
 * would move the expectation along with the output and the guard would agree
 * with whatever was produced. The duplication IS the check — a rename in either
 * copy fails "registers exactly the paths the generators write" in
 * `__tests__/collector-artifact-vendoring.test.ts`.
 *
 * This argument covers generator OUTPUTS only. It is not licence to re-declare
 * any other path: the ledger's own path has a canonical owner in
 * `collector-codegen-common.ts` and is imported, not copied.
 */
export const CollectorArtifact = {
  AllowlistManifest: "collector/allowed-attributes.json",
  RedactionFragment: "collector/keyless-telemetry-redaction.yaml",
  PosthogRoutingFragment: "collector/keyless-telemetry-posthog-routing.yaml",
  PosthogIdentityFragment: "collector/keyless-telemetry-posthog-identity.yaml",
  PosthogRoutingManifest: "collector/posthog-product-signals.json",
  PosthogIdentityManifest: "collector/posthog-identity-transform.json",
  TailSamplingFragment: "collector/tail-sampling.yaml",
} as const;
export type CollectorArtifact =
  (typeof CollectorArtifact)[keyof typeof CollectorArtifact];

export const CollectorArtifactVendoring = {
  Vendored: "vendored",
  Pending: "pending",
  RepoOnly: "repoOnly",
  Unknown: "unknown",
} as const;
export type CollectorArtifactVendoring =
  (typeof CollectorArtifactVendoring)[keyof typeof CollectorArtifactVendoring];

/**
 * The standing warning each state earns, or `undefined` for the states that are
 * settled and say nothing on a run.
 *
 * Exhaustive by construction: a `Record` keyed on the state union cannot be
 * written without naming every member, so adding a fifth state fails `tsc` here
 * rather than falling through to a silent default. A `Set` of the states that
 * warn would compile unchanged and quietly treat the new one as clean.
 *
 * `pending` and `unknown` get DIFFERENT wording because they are different
 * claims. For `pending` a human established the artifact is not deployed, so
 * saying the processor does nothing in production is a fact. For `unknown`
 * nobody has looked, and asserting the same thing would report an unmeasured
 * value as a measurement — the exact false-confidence this guard exists to stop.
 */
const STANDING_WARNING: Record<
  CollectorArtifactVendoring,
  ((path: string) => string) | undefined
> = {
  [CollectorArtifactVendoring.Vendored]: undefined,
  [CollectorArtifactVendoring.RepoOnly]: undefined,
  [CollectorArtifactVendoring.Pending]: (path) =>
    `Collector artifact declared NOT present in the DEPLOYED collector config, so the processor it defines does nothing in production: ${path}. ${vendorHint(path)}`,
  [CollectorArtifactVendoring.Unknown]: (path) =>
    `Collector artifact whose deployment has never been checked, so nothing here can say whether the processor it defines is live: ${path}. Read the deployed collector config and record the result — do not guess a state to silence this. ${vendorHint(path)}`,
};

const VENDORING_VALUES: readonly CollectorArtifactVendoring[] = Object.values(
  CollectorArtifactVendoring
);

const REGISTRY_PATHS: readonly CollectorArtifact[] =
  Object.values(CollectorArtifact);

const LEDGER_FIELD = "artifactVendoring" as const;

const CL_TOFU_COLLECTOR_TEMPLATE = "infrastructure `collector/config.yaml`";

const MANIFEST_NOT_VENDORED = `This manifest is not vendored anywhere — only this repo's own guards read it, which is why its generated header carries no "vendor this" instruction, so "${CollectorArtifactVendoring.RepoOnly}" is the state to record`;

const VENDOR_TARGET: Record<CollectorArtifact, string> = {
  [CollectorArtifact.RedactionFragment]: `Vendor it into ${CL_TOFU_COLLECTOR_TEMPLATE}`,
  [CollectorArtifact.PosthogRoutingFragment]: `Vendor it into the PostHog leg of ${CL_TOFU_COLLECTOR_TEMPLATE}`,
  [CollectorArtifact.PosthogIdentityFragment]: `Vendor it into the PostHog leg of ${CL_TOFU_COLLECTOR_TEMPLATE}`,
  [CollectorArtifact.TailSamplingFragment]: `Vendor it into the TRACES pipeline of ${CL_TOFU_COLLECTOR_TEMPLATE} (FEA-1992)`,
  [CollectorArtifact.AllowlistManifest]: MANIFEST_NOT_VENDORED,
  [CollectorArtifact.PosthogRoutingManifest]: MANIFEST_NOT_VENDORED,
  [CollectorArtifact.PosthogIdentityManifest]: MANIFEST_NOT_VENDORED,
};

const REGISTRY_HINT = `Add it to \`CollectorArtifact\` in scripts/collector-artifact-vendoring.ts and declare its deployment state in "${LEDGER_FIELD}" in ${CollectorVendoringLedgerPath}.`;

const DECLARE_HINT = `Declare it in "${LEDGER_FIELD}" in ${CollectorVendoringLedgerPath} as one of: ${VENDORING_VALUES.join(", ")}.`;

export type CollectorArtifactVendoringInput = {
  /** Every generated file present in `collector/`, as package-relative paths. */
  presentPaths: readonly string[];
  ledgerSource: string;
};

export function evaluateCollectorArtifactVendoring(
  input: CollectorArtifactVendoringInput
): CollectorGuardFinding[] {
  const findings: CollectorGuardFinding[] = [];
  const parsed = parseArtifactVendoring(input.ledgerSource, findings);
  findings.push(...diskFindings(input.presentPaths));
  if (parsed) {
    findings.push(...ledgerFindings(parsed.mentionedPaths));
  }
  return findings;
}

/**
 * The disk half: the generated set on disk must be exactly the registry.
 *
 * Both directions matter and they catch different regressions. An extra file is
 * a generator that started emitting an artifact nobody registered, so it is
 * unguarded and unvendored while every check stays green — the ISS-9220 shape,
 * one artifact later. A missing file is a rename or deletion, which is the
 * failure mode this repo has shipped more than once: a guard that reads a path
 * nothing writes any more checks nothing and exits 0.
 */
function diskFindings(
  presentPaths: readonly string[]
): CollectorGuardFinding[] {
  return diffFindings(
    CollectorVendoringLedgerPath,
    new Set<string>(REGISTRY_PATHS),
    new Set(
      presentPaths.filter((path) => path !== CollectorVendoringLedgerPath)
    ),
    {
      missingMessage: (missing) =>
        `Registered collector artifact(s) missing from disk, so the guard would check nothing for them: ${missing.join(", ")}. Regenerate the collector artifacts, or remove the entry from \`CollectorArtifact\` and ${CollectorVendoringLedgerPath} if the artifact was retired.`,
      extraMessage: (extra) =>
        `Generated collector artifact(s) present on disk but not registered, so nothing checks whether they are deployed: ${extra.join(", ")}. ${REGISTRY_HINT}`,
    }
  );
}

/**
 * The ledger half, diffed against every path the ledger MENTIONS rather than
 * every path it declares validly.
 *
 * An artifact declared with an unrecognized state is already reported by the
 * parser. Diffing against the valid-only map would report it a second time as
 * undeclared, which is false — it IS declared, just wrongly — and sends the
 * reader to add an entry that already exists.
 */
function ledgerFindings(
  mentionedPaths: ReadonlySet<string>
): CollectorGuardFinding[] {
  return diffFindings(
    CollectorVendoringLedgerPath,
    new Set<string>(REGISTRY_PATHS),
    mentionedPaths,
    {
      missingMessage: (missing) =>
        `Collector artifact(s) with no declared deployment state, so a green here says nothing about whether they reached the collector: ${missing.join(", ")}. ${DECLARE_HINT}`,
      extraMessage: (extra) =>
        `Ledger declares collector artifact(s) no generator emits (stale): ${extra.join(", ")}. Remove them from "${LEDGER_FIELD}" in ${CollectorVendoringLedgerPath}.`,
    }
  );
}

type ParsedArtifactVendoring = {
  /** Only the entries carrying a recognized state. */
  declared: ReadonlyMap<string, CollectorArtifactVendoring>;
  /** Every key the ledger names, valid state or not. */
  mentionedPaths: ReadonlySet<string>;
};

function parseArtifactVendoring(
  source: string,
  findings: CollectorGuardFinding[]
): ParsedArtifactVendoring | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Vendoring ledger is not valid JSON: ${describeError(error)}.`,
    });
    return undefined;
  }

  const field = isRecord(parsed) ? parsed[LEDGER_FIELD] : undefined;
  if (!isRecord(field)) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Vendoring ledger must define "${LEDGER_FIELD}" as an object mapping each generated collector artifact to its deployment state. ${DECLARE_HINT}`,
    });
    return undefined;
  }

  const declared = new Map<string, CollectorArtifactVendoring>();
  const invalid: string[] = [];
  for (const [path, state] of Object.entries(field)) {
    if (isVendoringState(state)) {
      declared.set(path, state);
    } else {
      invalid.push(path);
    }
  }

  if (invalid.length > 0) {
    findings.push({
      file: CollectorVendoringLedgerPath,
      message: `Collector artifact(s) declared with an unrecognized deployment state: ${invalid.sort().join(", ")}. ${DECLARE_HINT}`,
    });
  }

  return { declared, mentionedPaths: new Set(Object.keys(field)) };
}

function isVendoringState(value: unknown): value is CollectorArtifactVendoring {
  return VENDORING_VALUES.includes(value as CollectorArtifactVendoring);
}

/**
 * The standing warnings, which are the point rather than decoration.
 *
 * A `pending` or `unknown` artifact silences the failing finding by design, so
 * without a line on every run the guard's output for "everything vendored" and
 * "the identity transform has been dark for ten weeks" would be identical —
 * which is exactly the pre-ISS-9221 silence with a JSON key added to it. A diff
 * is read once; an artifact can sit undeployed for months.
 */
export function collectorArtifactVendoringWarnings(
  ledgerSource: string
): string[] {
  const parsed = parseArtifactVendoring(ledgerSource, []);
  if (!parsed) {
    return [];
  }

  return [...parsed.declared.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, state]) => {
      const warn = STANDING_WARNING[state];
      return warn ? [warn(path)] : [];
    });
}

/**
 * One artifact's declared state, or `undefined` when the ledger does not name it
 * or names it with a value outside the union.
 *
 * Parse findings are discarded rather than surfaced: every one of them is
 * already reported by `evaluateCollectorArtifactVendoring` on the same run, and
 * repeating them here would be the same double-report `ledgerFindings` exists to
 * avoid.
 */
export function declaredArtifactVendoring(
  ledgerSource: string,
  artifact: CollectorArtifact
): CollectorArtifactVendoring | undefined {
  return parseArtifactVendoring(ledgerSource, [])?.declared.get(artifact);
}

/**
 * Whether the artifact dimension is readable at all.
 *
 * `declaredArtifactVendoring` returns `undefined` both for an artifact the
 * ledger does not name and for one it cannot name because the whole field is
 * malformed. A caller resolving a subject against this dimension needs the two
 * apart: the second is already reported here, so treating it as "not declared"
 * would blame the caller's own entry for a defect one field over.
 */
export function artifactVendoringDeclared(ledgerSource: string): boolean {
  return parseArtifactVendoring(ledgerSource, []) !== undefined;
}

export function isRegisteredArtifact(
  value: string
): value is CollectorArtifact {
  return (REGISTRY_PATHS as readonly string[]).includes(value);
}

/**
 * The remediation line, with the destination resolved for THIS artifact.
 *
 * The warnings iterate every validly-stated ledger entry, which includes one
 * naming a path no generator emits — already reported as stale by
 * `ledgerFindings`, so the hint says that rather than inventing a destination
 * for a file that does not exist.
 */
function vendorHint(path: string): string {
  const target = isRegisteredArtifact(path)
    ? VENDOR_TARGET[path]
    : "This path is declared in the ledger but no generator emits it (see the stale finding on the same run), so there is nothing to vendor";
  return `${target}. Then set its "${LEDGER_FIELD}" entry in ${CollectorVendoringLedgerPath}, naming the infrastructure commit in "$vendoredFrom" for a "${CollectorArtifactVendoring.Vendored}".`;
}
