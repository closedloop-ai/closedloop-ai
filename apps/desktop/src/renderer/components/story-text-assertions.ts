/**
 * Text assertions for desktop story `play` functions.
 *
 * `storybook/test` (`expect`, `within`) is not resolvable from `apps/desktop` —
 * only `apps/storybook` depends on the storybook package — so desktop stories
 * that want to prove they rendered the state they claim have to bring their own.
 * That matters more here than it looks: ISS-5287 runs every story as a test, and
 * a story with no assertions passes while rendering entirely the wrong state.
 *
 * Extracted from `sidebar-account-footer.stories.tsx` when a second desktop
 * story needed the same checks.
 */

const TEXT_POLL_ATTEMPTS = 40;
const TEXT_POLL_INTERVAL_MS = 25;

/**
 * Wait for `text` to appear. For canvases whose state arrives asynchronously — a
 * flag resolving over IPC, a query settling — where a synchronous read would
 * catch the pre-resolution fallback and pass on it.
 */
export async function waitForText(
  root: HTMLElement,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < TEXT_POLL_ATTEMPTS; attempt++) {
    if (root.textContent?.includes(text)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, TEXT_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`"${text}" never appeared in this story canvas`);
}

/** Assert `text` is not rendered. Synchronous: absence needs no polling. */
export function assertTextAbsent(root: HTMLElement, text: string): void {
  if (root.textContent?.includes(text)) {
    throw new Error(`"${text}" must not appear in this story canvas`);
  }
}

/**
 * Assert a button with this exact label is rendered.
 *
 * Text presence alone would pass on prose that happens to contain the words, so
 * a story about a call-to-action asserts the control rather than the copy.
 */
export function assertButtonPresent(root: HTMLElement, name: string): void {
  const match = Array.from(root.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === name
  );
  if (!match) {
    throw new Error(`No button labelled "${name}" in this story canvas`);
  }
}
