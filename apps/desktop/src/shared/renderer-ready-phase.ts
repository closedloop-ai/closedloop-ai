/**
 * ISS-5346: which renderer milestone a `desktop:renderer-ready` IPC reports.
 *
 * The renderer announces readiness TWICE per window load, and the difference
 * between them is the whole bug this ticket fixes:
 *
 *   - `Shell` — `renderer-ready-signal.ts`, a module script in `index.html`,
 *     runs BEFORE the React entry mounts. It means "index.html painted", i.e.
 *     a static shell with no application UI in it.
 *   - `Mounted` — `main.tsx`'s `RendererReadySignal` `useLayoutEffect`, which
 *     runs after the React tree has committed. It means "the app is on screen".
 *
 * Revealing the window on `Shell` is what exposed the dead shell. The reveal is
 * now gated on `Mounted`, with `Shell` only ARMING the bounded wait so a
 * renderer that never mounts still gets its window shown.
 *
 * Optional on the wire and defaulted to `Shell` in main: a payload-free
 * `desktop:renderer-ready` (any caller that has not been taught the phase) keeps
 * its pre-ISS-5346 meaning rather than being read as a mount.
 */
export const RendererReadyPhase = {
  /** The static `index.html` shell painted; React has NOT mounted yet. */
  Shell: "shell",
  /** The React entry mounted and committed its first render. */
  Mounted: "mounted",
} as const;

export type RendererReadyPhase =
  (typeof RendererReadyPhase)[keyof typeof RendererReadyPhase];

/**
 * Narrow an untrusted `desktop:renderer-ready` payload to a known phase.
 *
 * The renderer is a trust boundary, so an absent, unknown, or non-string phase
 * degrades to `Shell` — the conservative reading, since `Shell` only arms the
 * bounded wait and never reveals on its own.
 */
export function toRendererReadyPhase(value: unknown): RendererReadyPhase {
  return value === RendererReadyPhase.Mounted
    ? RendererReadyPhase.Mounted
    : RendererReadyPhase.Shell;
}
