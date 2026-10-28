/**
 * Project Detail's default Group: with manual ordering the shipped default is
 * the hierarchy tree, so Group reads None; without it the Status-grouped grid
 * stays the default. An explicit `group` in the URL always wins over either.
 */
export function projectDefaultGroupBy(manualOrderingEnabled: boolean): string {
  return manualOrderingEnabled ? "none" : "status";
}
