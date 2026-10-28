/**
 * The frozen five-literal tuple the implementation exports. Declared with its
 * literal members rather than as `readonly string[]`: this set IS the signing
 * contract, so dropping or renaming a var should fail typecheck at the consumer
 * — a widened element type makes every exhaustiveness check over it vacuous.
 */
export declare const REQUIRED_MAC_SIGNING_ENV_VARS: readonly [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];

export declare const MacSigningMode: {
  readonly Signed: "signed";
  readonly Unsigned: "unsigned";
  readonly Partial: "partial";
  readonly Misconfigured: "misconfigured";
};

export type MacSigningMode =
  (typeof MacSigningMode)[keyof typeof MacSigningMode];

export type MacSigningClassification = {
  mode: MacSigningMode;
  emptyDefined: string[];
  absent: string[];
  configured: string[];
};

export declare function classifyMacSigningEnv(
  env: Record<string, string | undefined>
): MacSigningClassification;

export declare function macSigningFailureMessage(
  emptyDefinedNames: readonly string[]
): string;

/**
 * ISS-10381 — the transient-signing-failure allowlist.
 *
 * Returns the class name a second packaging attempt is worth trying for, or
 * `null` for everything else. `string | null` rather than a boolean on purpose:
 * the caller puts the class name in the annotation a run is read by, and "no
 * known transient class" must not be spellable as `false` beside a `true` that
 * carries no reason.
 */
export declare function classifyRetryableMacSigningFailure(
  output: string
): string | null;
