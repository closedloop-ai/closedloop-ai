/**
 * Filter out connections marked `readOnly` in their presence — those are
 * historical-version readers (PLN-655) and should not appear in live
 * editors' avatar stacks. Used by `<Presence>` and `<InlinePresence>` in
 * `presence.tsx`. Lives in its own file (no React / design-system imports)
 * so it can be unit-tested without standing up Liveblocks or rendering
 * fixtures.
 */
export function filterLiveOthers<
  T extends { presence: { readOnly?: boolean } },
>(others: readonly T[]): T[] {
  return others.filter((o) => o.presence.readOnly !== true);
}
