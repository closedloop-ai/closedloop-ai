import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";

/**
 * Where the viewer's dev-mode choice is persisted (ISS-7477).
 *
 * Per device, not per account: the choice is "how do I want THIS browser to
 * render right now", it never leaves the machine, and it survives reload —
 * `useLocalStorageState` also syncs it across tabs of the same profile. A signed
 * out or ineligible viewer is pinned to dev-mode ON regardless of what this key
 * holds, so a stale value can never put a customer into the customer view.
 */
export const DEV_MODE_STORAGE_KEY = "closedloop:dev-mode";

/**
 * The flags that keep resolving normally while the customer view is active.
 *
 * This list is NOT the mechanism — the customer view suppresses every key it is
 * not told to exempt, so a flag created tomorrow is suppressed the day it exists
 * with no edit here. It holds exactly the escape hatch: the gate on the control
 * that turns the customer view back off. Anything else added here is a hole in
 * the view, and needs the reason written down beside it.
 */
export const DEV_MODE_EXEMPT_FLAG_KEYS: readonly string[] = [DEV_MODE_FLAG_KEY];

/**
 * What the switch is called, wherever it renders.
 *
 * ISS-9891 gave the control a second presentation — a sidebar row under Labs
 * alongside the account-menu row it replaced. ISS-10195 retired the gate and the
 * account menu with it, so the sidebar rows are the only presentations left; the
 * constant stays shared because the Labs row and the footer fallback row are
 * still two surfaces reading one word. The word is also the control's ACCESSIBLE
 * NAME on both, so a drift here silently splits what a screen-reader user is
 * told to look for.
 *
 * Deliberately "dev mode", the state the switch REPORTS, not "customer view",
 * the state turning it off produces — a switch you have to turn OFF to get the
 * behaviour it is named after inverts on every read.
 */
export const DEV_MODE_CONTROL_LABEL = "Dev mode";

/**
 * The honesty note that ships beside the switch (ISS-7835 AC4), shared for the
 * same reason as the label above.
 *
 * The customer view is built out of CLIENT flag suppression, so a flag the
 * server evaluates per viewer still resolves at this internal viewer's own
 * rollout and shapes the response accordingly. Rendering the customer's chrome
 * over data that is not the customer's is the failure this states: the viewer
 * must not walk away believing they have seen what a customer sees. It is
 * worded to read in BOTH switch states, and it is the `aria-describedby` target
 * on both surfaces, so it is announced rather than merely adjacent.
 */
export const DEV_MODE_CUSTOMER_VIEW_SCOPE_NOTE =
  "Dev mode off hides internal-only features. Your data is unchanged, so this is not what a customer would see.";
