// Static page copy kept out of the component so it reads as content, not layout.
export const signInCopy = {
  heading: "Welcome to Closedloop",
  emailLabel: "Email address",
  emailPlaceholder: "Enter your email address",
  continueLabel: "Continue",
  signUpPrompt: "Don't have an account?",
  signUpCta: "Sign up",
} as const;

/**
 * Footer chrome, deliberately NOT interactive. These have no destination yet —
 * there is no privacy or terms route in `apps/web` — and a button that looks
 * clickable and does nothing is the thing this sandbox is supposed to catch,
 * not ship. They carry no `href` for the same reason: an unread field reads as
 * intent that was never wired.
 */
export const footerLabels: readonly string[] = ["Privacy", "Terms"];

/**
 * The stops a signed-out desktop "Connect to GitHub" click passes through
 * (PLN-1526), plus the failure branch off the first one.
 *
 * `sign-in` is the fallback this deep link exists to ROUTE AROUND, not step one
 * of the happy path — it is in the rail because a user whose OAuth hand-off
 * fails still lands there, and because it is the screen the flow used to open
 * with. The `ours` flag marks the two stops we do not draw: GitHub's own
 * authorize page, and the desktop hand-back, which is a navigation.
 */
export const ConnectStep = {
  SignIn: "sign-in",
  Redirecting: "redirecting",
  Failure: "failure",
  GitHub: "github",
  Callback: "callback",
  Consent: "consent",
  Handoff: "handoff",
} as const;
export type ConnectStep = (typeof ConnectStep)[keyof typeof ConnectStep];

export type ConnectStepEntry = {
  id: ConnectStep;
  /** Short label for the step rail. */
  label: string;
  /** The route or actor behind this stop. */
  source: string;
  /** Whether this is a screen we design. */
  ours: boolean;
  /** A branch off the happy path rather than a stop along it. */
  branch?: boolean;
};

export const connectSteps: readonly ConnectStepEntry[] = [
  {
    id: ConnectStep.Redirecting,
    label: "Taking you to GitHub",
    source: "/connect/github",
    ours: true,
  },
  {
    id: ConnectStep.Failure,
    label: "We couldn't open GitHub",
    source: "/connect/github, after the 10s ceiling",
    ours: true,
    branch: true,
  },
  {
    id: ConnectStep.SignIn,
    label: "Sign in",
    source: "/sign-in, the fallback we route around",
    ours: true,
    branch: true,
  },
  {
    id: ConnectStep.GitHub,
    label: "Authorize on GitHub",
    source: "github.com",
    ours: false,
  },
  {
    id: ConnectStep.Callback,
    label: "Finishing sign-in",
    source: "/sso-callback",
    ours: true,
  },
  {
    id: ConnectStep.Consent,
    label: "Connect this device",
    source: "/settings/integrations/desktop/authorize",
    ours: true,
  },
  {
    id: ConnectStep.Handoff,
    label: "Returning to desktop",
    source: "127.0.0.1 loopback",
    ours: true,
  },
];

/**
 * What the consent step shows.
 *
 * `grant` is the line that was missing: device, platform, and workspace are
 * cosmetic facts, and a consent screen that lists only those is asking for
 * approval without naming what is being approved. Every other field comes from
 * the desktop authorize query string the browser was opened with —
 * `device_name` and `platform` verbatim, workspace from the signed-in org — so
 * nothing here presumes an API change.
 *
 * The application name is deliberately absent: it is a constant, and the
 * sentence above the list already says "Closedloop Desktop".
 */
export const deviceConsent = {
  grant: "A signed-in Closedloop session, held on this machine",
  device: "Kris' MacBook Pro",
  platform: "macOS",
  workspace: "closedloop-ai",
} as const;
