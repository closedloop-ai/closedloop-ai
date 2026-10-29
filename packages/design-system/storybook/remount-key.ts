/**
 * A story's `key` on its rendered component, so a Controls-driven
 * "initial*" / "default*" seed arg forces a remount instead of leaving the
 * component's own internal state stale after the seed changes. Every story
 * that seeds internal state this way should call this instead of picking
 * its own `JSON.stringify`/`String`/template-literal expression, which is
 * how the same fix drifted into a slightly different shape in each story
 * that needed it. Lives beside `component-catalog.ts` and `mock-data.ts`:
 * Storybook-only code shared by both apps/storybook and the story files
 * colocated inside packages/app feature components, which can't import
 * from each other directly.
 */
export function remountKey(...parts: readonly unknown[]): string {
  return parts.map((part) => JSON.stringify(part)).join("-");
}
