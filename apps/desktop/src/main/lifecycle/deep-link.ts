import { resolve } from "node:path";
import { DESKTOP_DEEP_LINK_SCHEME } from "@repo/api/src/types/desktop-deep-link";
import { handleActivateEvent } from "./app-lifecycle.js";

/**
 * Why an incoming `closedloop://` URL was refused.
 *
 * Logged INSTEAD OF the URL itself: a deep link is attacker-supplied text from
 * an arbitrary web page, and the main log is read by support and shipped in
 * diagnostics bundles. The reason is what an operator needs; the payload is not.
 */
export const DeepLinkRejection = {
  Unparseable: "unparseable",
  ForeignScheme: "foreign-scheme",
  EmbeddedCredentials: "embedded-credentials",
  UnexpectedPayload: "unexpected-payload",
} as const;
export type DeepLinkRejection =
  (typeof DeepLinkRejection)[keyof typeof DeepLinkRejection];

export type ProtocolClientRegistration = {
  scheme: string;
  /** Only set for an unpackaged build, which the OS cannot resolve by bundle. */
  path?: string;
  args?: string[];
};

/**
 * Classifies a deep link, returning `null` when it is the one accepted form.
 *
 * Deny by default. The ONLY thing this app accepts is the bare, payload-free
 * `closedloop://` — no host, path, query, fragment, or credentials. Every field
 * a URL can carry is checked, so `closedloop://evil.example/x`,
 * `closedloop://?redirect=…`, and `closedloop://user:pw@host/` are all refused
 * rather than reaching any code that could act on them.
 */
export function classifyDeepLink(url: string): DeepLinkRejection | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return DeepLinkRejection.Unparseable;
  }
  // `URL` lowercases the scheme, so `CLOSEDLOOP://` compares equal here.
  if (parsed.protocol !== `${DESKTOP_DEEP_LINK_SCHEME}:`) {
    return DeepLinkRejection.ForeignScheme;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return DeepLinkRejection.EmbeddedCredentials;
  }
  // A lone "/" is what `closedloop:///` normalizes to, and it carries no more
  // data than the empty path. Refusing it would be indistinguishable from an
  // unregistered scheme (a refusal is deliberately silent), so a launcher that
  // hands back the three-slash spelling would make the whole feature look dead
  // AND make the web fallback tell a current build it is out of date. Anything
  // with actual path bytes — `closedloop:///etc/passwd` — still has a longer
  // pathname and is still refused, so this widens the policy by zero bytes.
  const hasPathPayload = parsed.pathname !== "" && parsed.pathname !== "/";
  if (
    parsed.host !== "" ||
    hasPathPayload ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return DeepLinkRejection.UnexpectedPayload;
  }
  // `URL` percent-decodes and collapses dot segments BEFORE any check above
  // sees them, so `closedloop:///%2e`, `closedloop:///..`, and
  // `closedloop:///%2e%2e` all arrive here with pathname "/" and would pass a
  // parsed-only policy. Payload-free has to mean payload-free in the spelling
  // the OS actually handed us, so pin the raw form too.
  if (!isAcceptedDeepLinkSpelling(url)) {
    return DeepLinkRejection.UnexpectedPayload;
  }
  return null;
}

export function isAllowedDeepLink(url: string): boolean {
  return classifyDeepLink(url) === null;
}

/**
 * Finds the deep link the OS appended to a launch's argv (Windows/Linux).
 *
 * Matches on the scheme prefix ALONE so a hostile payload is found and then
 * explicitly refused by {@link classifyDeepLink}, rather than being skipped here
 * and silently treated as "no deep link arrived".
 */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.toLowerCase().startsWith(DEEP_LINK_PREFIX)) {
      return arg;
    }
  }
  return null;
}

/**
 * Whether this build can own the scheme at the OS level.
 *
 * macOS resolves a protocol client from the RUNNING BUNDLE's `Info.plist`. An
 * unpackaged dev build is `Electron.app`, which declares no `CFBundleURLTypes`
 * for this scheme, so registering there cannot make the link work — and it would
 * point LaunchServices at the generic Electron binary, stealing `closedloop://`
 * from a properly installed Closedloop.app on the same machine. Skip it.
 *
 * Windows and Linux resolve from an explicit command line, so the dev form in
 * {@link resolveProtocolClientRegistration} genuinely works unpackaged there.
 */
export function shouldRegisterProtocolClient(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return options.isPackaged || options.platform !== "darwin";
}

/**
 * Builds the `setAsDefaultProtocolClient` arguments for this build.
 *
 * A packaged build registers by bundle/executable and needs no explicit path. An
 * unpackaged build is launched as `electron <app-dir>`, so the OS must be told
 * both the Electron binary and the app directory or it will re-launch a bare
 * Electron with no app to run.
 */
export function resolveProtocolClientRegistration(options: {
  isPackaged: boolean;
  execPath: string;
  argv: readonly string[];
}): ProtocolClientRegistration {
  if (options.isPackaged) {
    return { scheme: DESKTOP_DEEP_LINK_SCHEME };
  }
  const appPath = options.argv[1];
  // Never let an incoming deep link become the registered app path. `args` is
  // persisted by the OS (Windows registry command line, Linux .desktop `Exec`),
  // and after a bare-form re-launch the OS-appended URL is itself argv[1] — so
  // without this check an attacker-supplied string could be resolved into that
  // durable registration.
  if (
    appPath === undefined ||
    appPath.toLowerCase().startsWith(DEEP_LINK_PREFIX)
  ) {
    return { scheme: DESKTOP_DEEP_LINK_SCHEME };
  }
  return {
    scheme: DESKTOP_DEEP_LINK_SCHEME,
    path: options.execPath,
    args: [resolve(appPath)],
  };
}

/**
 * Claims `closedloop://` for this app, returning whether the OS accepted it.
 *
 * Never throws: a refused or unavailable registration degrades to a logged
 * no-op, because failing to own a convenience deep link must not fail a launch.
 */
export function registerDeepLinkProtocolClient(deps: {
  isPackaged: boolean;
  execPath: string;
  argv: readonly string[];
  platform: NodeJS.Platform;
  setAsDefaultProtocolClient: (
    scheme: string,
    path?: string,
    args?: string[]
  ) => boolean;
  log: (message: string) => void;
}): boolean {
  if (
    !shouldRegisterProtocolClient({
      isPackaged: deps.isPackaged,
      platform: deps.platform,
    })
  ) {
    deps.log(
      `not claiming ${DESKTOP_DEEP_LINK_SCHEME}:// from an unpackaged macOS build; only the packaged bundle can own it`
    );
    return false;
  }
  const registration = resolveProtocolClientRegistration({
    argv: deps.argv,
    execPath: deps.execPath,
    isPackaged: deps.isPackaged,
  });
  let registered: boolean;
  try {
    registered = deps.setAsDefaultProtocolClient(
      registration.scheme,
      registration.path,
      registration.args
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log(
      `failed to claim ${DESKTOP_DEEP_LINK_SCHEME}://: ${message}; the web launch control will not reach this app`
    );
    return false;
  }
  deps.log(
    registered
      ? `claimed ${DESKTOP_DEEP_LINK_SCHEME}:// as the default protocol client`
      : `the OS refused ${DESKTOP_DEEP_LINK_SCHEME}://; the web launch control will not reach this app`
  );
  return registered;
}

/**
 * Acts on an OS-delivered deep link: focus the app, or refuse and do nothing.
 *
 * A refused link produces NO side effect at all — not even a window raise — so a
 * hostile page cannot use a malformed payload to drive this process. The URL
 * never reaches `loadURL`, `openExternal`, a file path, or a child process on
 * any path; the sole effect of an accepted link is the same activation a user
 * gets from clicking the dock icon.
 */
export async function handleDeepLinkActivation(deps: {
  url: string;
  activate: () => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  const rejection = classifyDeepLink(deps.url);
  if (rejection !== null) {
    deps.log(`refused ${DESKTOP_DEEP_LINK_SCHEME} deep link: ${rejection}`);
    return;
  }
  await handleActivateEvent({
    handleActivate: deps.activate,
    log: deps.log,
  });
}

export type DeepLinkListeners = {
  onOpenUrl: (
    event: { preventDefault: () => void },
    url: string
  ) => Promise<void>;
  onSecondInstance: (event: unknown, argv: readonly string[]) => Promise<void>;
};

/**
 * Builds the two Electron listeners that deliver a deep link, as plain functions
 * `startup.ts` hands to `app.on` (mirroring `registerProfileConfigIpcHandlers`).
 *
 * Extracted rather than written inline so the delivery decisions — drop a
 * pre-`ready` link, still focus on a plain double-launch, refuse a hostile argv
 * — are reachable by a test without booting Electron. Both return their promise
 * so a test can await it; Electron ignores listener return values.
 */
export function createDeepLinkListeners(deps: {
  isReady: () => boolean;
  activate: () => Promise<void>;
  logDeepLink: (message: string) => void;
  logDeepLinkInfo: (message: string) => void;
  logSecondInstance: (message: string) => void;
}): DeepLinkListeners {
  return {
    onOpenUrl: (event, url) => {
      event.preventDefault();
      if (!deps.isReady()) {
        // A cold-start link is served by the boot this launch is already doing,
        // so there is no activation to run — but it still gets classified, or a
        // hostile spelling would be the ONE delivery path that never reaches the
        // deny policy and never appears in the log an operator reads.
        const rejection = classifyDeepLink(url);
        if (rejection !== null) {
          deps.logDeepLink(
            `refused ${DESKTOP_DEEP_LINK_SCHEME} deep link delivered before ready: ${rejection}`
          );
          return Promise.resolve();
        }
        deps.logDeepLinkInfo(
          "deep link arrived before ready; this launch already serves it"
        );
        return Promise.resolve();
      }
      return handleDeepLinkActivation({
        activate: deps.activate,
        log: deps.logDeepLink,
        url,
      });
    },
    onSecondInstance: (_event, argv) => {
      const deepLink = findDeepLinkInArgv(argv);
      if (deepLink === null) {
        // A plain double-launch carries no link and keeps focusing, exactly as
        // it did before this scheme existed (FEA-3132 E5).
        return handleActivateEvent({
          handleActivate: deps.activate,
          log: deps.logSecondInstance,
        });
      }
      return handleDeepLinkActivation({
        activate: deps.activate,
        log: deps.logDeepLink,
        url: deepLink,
      });
    },
  };
}

export type InitialDeepLink = {
  rejection: DeepLinkRejection | null;
};

/**
 * Classifies the deep link, if any, that STARTED this process (Windows/Linux
 * first instance), returning `null` when the launch carried none.
 *
 * The `second-instance` listener only ever sees the argv of a LATER launch, so
 * without this the first instance is the one delivery path whose link is never
 * classified. It deliberately returns only the verdict and never the URL: the
 * caller's job is to log the reason, and nothing in this process may act on a
 * cold-start payload.
 */
export function classifyInitialDeepLink(
  argv: readonly string[]
): InitialDeepLink | null {
  const url = findDeepLinkInArgv(argv);
  if (url === null) {
    return null;
  }
  return { rejection: classifyDeepLink(url) };
}

/**
 * Logs how the link that started this process was classified.
 *
 * Log-only by design. The OS starts this process for ANY `closedloop://…`
 * string before a line of our code runs — that is what registering a scheme
 * means — so a cold start cannot be refused, only reported. What the deny policy
 * still guarantees at boot is what it guarantees everywhere else: a refused
 * payload reaches no handler, no window activation, and no log line carrying the
 * URL. Suppressing the boot itself would leave an invisible background process
 * behind a click the user made, which is strictly worse than the app opening.
 */
export function reportInitialDeepLink(deps: {
  argv: readonly string[];
  logRefused: (message: string) => void;
  logAccepted: (message: string) => void;
}): void {
  const initial = classifyInitialDeepLink(deps.argv);
  if (initial === null) {
    return;
  }
  if (initial.rejection !== null) {
    deps.logRefused(
      `refused the ${DESKTOP_DEEP_LINK_SCHEME} deep link this launch started with: ${initial.rejection}; booting without acting on it`
    );
    return;
  }
  deps.logAccepted(
    `launched by a ${DESKTOP_DEEP_LINK_SCHEME} deep link; this boot serves it`
  );
}

const DEEP_LINK_PREFIX = `${DESKTOP_DEEP_LINK_SCHEME}:`;

/**
 * The entire accepted set, as SPELLED by the OS: `closedloop:` (bare),
 * `closedloop://` (what the web control fires), and `closedloop:///` (the
 * empty-authority spelling a launcher can hand back). None carries a byte the
 * others do not.
 */
const ACCEPTED_DEEP_LINK_AUTHORITIES: ReadonlySet<string> = new Set([
  "",
  "//",
  "///",
]);

/** Trailing `?`/`#` delimiters with nothing after them — separators, not data. */
const RE_TRAILING_EMPTY_DELIMITERS = /[?#]*$/;

/**
 * Whether the RAW spelling is one of the accepted literals.
 *
 * Compared before the URL parser gets to decode or collapse anything, which is
 * the whole point: a parsed-only policy accepts `closedloop:///%2e` because the
 * parser turned it into `/` first.
 */
function isAcceptedDeepLinkSpelling(url: string): boolean {
  const authority = url
    .slice(DEEP_LINK_PREFIX.length)
    .replace(RE_TRAILING_EMPTY_DELIMITERS, "");
  return ACCEPTED_DEEP_LINK_AUTHORITIES.has(authority);
}
