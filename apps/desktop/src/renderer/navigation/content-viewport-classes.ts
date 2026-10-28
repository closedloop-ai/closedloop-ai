/**
 * The App-shell content viewport's layout classes.
 *
 * Lives beside `use-content-scroll-restoration.ts` because the two decide one
 * thing between them: whether this element scrolls, and what happens to the
 * offset when it does. It left `App.tsx` so both halves can be driven directly
 * (ISS-12288) rather than through a full shell render.
 *
 * On the Sessions list route this element never actually overflows — the grid's
 * own scroll band is the scroller there — so the offset half restores nothing
 * (ISS-12471).
 */

/**
 * A detail route manages its own internal scrolling regions, so the shell's
 * viewport must not add a second scrollbar around them; a list route scrolls
 * here.
 */
export function contentViewportClasses(input: {
  detailSessionId: string | null;
  detailBranchId: string | null;
  detailDocumentSlug: string | null;
  agentDetailOpen: boolean;
}): string {
  return input.detailSessionId ||
    input.detailBranchId ||
    input.detailDocumentSlug ||
    input.agentDetailOpen
    ? "flex min-h-0 flex-1 flex-col overflow-hidden"
    : "flex-1 overflow-auto";
}
