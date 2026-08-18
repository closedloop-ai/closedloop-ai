/**
 * Best-effort provider attribution from a model identifier.
 *
 * Lifted out of `components/overview/usage-graph-toggles.tsx` (FEA-4027) so a
 * surface that needs the attribution WITHOUT the toggle chrome — the desktop
 * first-launch tour's models caption (ISS-5112) — resolves providers from the
 * same rules the "by provider" grouping already uses, instead of a second
 * inference table that can drift from it.
 */

/** The bucket every unrecognized model id falls into. */
export const OTHER_MODEL_PROVIDER = "Other" as const;

/** Infer the provider that serves `model`, by identifier convention. */
export function providerOf(model: string): string {
  const id = model.toLowerCase();
  if (id.includes("claude")) {
    return "Anthropic";
  }
  if (
    id.includes("gpt") ||
    id.includes("codex") ||
    id.startsWith("o1") ||
    id.startsWith("o3")
  ) {
    return "OpenAI";
  }
  if (id.includes("gemini")) {
    return "Google";
  }
  return OTHER_MODEL_PROVIDER;
}
