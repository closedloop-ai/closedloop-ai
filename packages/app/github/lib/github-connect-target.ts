import type { GitHubConnectAction } from "./github-connect-action";

/**
 * A connect control's whole contract: WHAT it performs, and HOW this surface
 * performs it.
 *
 * The destination is one value with two mutually exclusive shapes, so a surface
 * that owns a connect action cannot also carry a navigation href. That pairing
 * is the FEA-3280 dead click: the desktop renderer's href store turns such a
 * link into an inert in-app navigation that never reaches the connect flow.
 * Before ISS-5958 the two travelled as separate optional props and the
 * precedence between them was a comment; now the wrong shape fails `tsc`.
 */
export type GitHubConnectTarget = {
  /** Decides the control's label and explanation (ISS-5958). */
  action: GitHubConnectAction;
} & (
  | { href: string; onConnect?: never }
  | { onConnect: () => void | Promise<void>; href?: never }
);
