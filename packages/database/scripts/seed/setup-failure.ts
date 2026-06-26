/**
 * Stable markers that tag seed *setup/guard* failures (as opposed to ordinary
 * fixture failures): the schema guard and the synthetic bootstrap throw errors
 * prefixed with the matching marker, so a setup/guard failure is recognizable
 * in the seed's output.
 *
 * The preview-pipeline classifier that distinguishes these from fixture
 * failures (to log them distinctly / surface "data not seeded") is tracked in
 * FEA-1715, alongside the rest of the preview seed integration. Keeping the
 * strings in one place keeps the producers (schema guard, bootstrap) and that
 * future consumer in sync.
 */
export const SeedSetupFailureMarker = {
  SchemaGuard: "seed_schema_guard_failed",
  Bootstrap: "seed_bootstrap_failed",
} as const;
export type SeedSetupFailureMarker =
  (typeof SeedSetupFailureMarker)[keyof typeof SeedSetupFailureMarker];
