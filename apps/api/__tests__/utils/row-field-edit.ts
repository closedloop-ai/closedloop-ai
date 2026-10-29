/**
 * ISS-9485: the row fields a PATCH must refuse with `unsupported_field` —
 * every registry key that is not also a body key of the same name. Read off
 * the registry so a newly classified field joins every refusal sweep.
 */
export function refusedRowFields(
  registry: Readonly<Record<string, string>>
): string[] {
  return Object.entries(registry)
    .filter(([key, edit]) => edit !== key)
    .map(([key]) => key);
}
