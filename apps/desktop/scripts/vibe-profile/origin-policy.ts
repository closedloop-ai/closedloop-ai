/**
 * Which API and web origins a vibe profile may be signed in to and launched
 * against (ISS-12056 decision 5): a throwaway local stack on loopback, or the
 * stable branch alias of one stage preview. Never production, never stage's
 * main hosts, and never a per-deployment alias (app and api deployment hashes
 * differ, so only the `-git-` alias names an API twin; see
 * `isUnreachableApiPreviewHost` in apps/app/lib/api-origin.ts).
 */

export const VibeOriginKind = {
  Loopback: "loopback",
  BranchPreview: "branch-preview",
} as const;
export type VibeOriginKind =
  (typeof VibeOriginKind)[keyof typeof VibeOriginKind];

export const VibeOriginVerdict = {
  ...VibeOriginKind,
  Refused: "refused",
} as const;
export type VibeOriginVerdict =
  (typeof VibeOriginVerdict)[keyof typeof VibeOriginVerdict];

export type VibeOriginDecision =
  | {
      readonly verdict: typeof VibeOriginVerdict.Loopback;
      readonly apiOrigin: string;
      readonly webOrigin: string;
    }
  | {
      readonly verdict: typeof VibeOriginVerdict.BranchPreview;
      readonly apiOrigin: string;
      readonly webOrigin: string;
      readonly slug: string;
    }
  | {
      readonly verdict: typeof VibeOriginVerdict.Refused;
      readonly reason: string;
    };

export const STAGE_PREVIEW_DOMAIN = "preview.stage.example";

/**
 * Decides whether `apiOrigin` and `webOrigin` (raw flag values) are a pair a
 * vibe profile may use. Loopback origins are normalized to their origin as
 * they always were; a preview origin must be exactly the bare HTTPS alias, and
 * both flags must name the same kind (and, for previews, the same branch).
 */
export function decideVibeProfileOrigins(
  apiOrigin: string,
  webOrigin: string
): VibeOriginDecision {
  const api = classifyOrigin(apiOrigin, OriginRole.Api);
  const web = classifyOrigin(webOrigin, OriginRole.Web);
  if (api.kind === VibeOriginVerdict.Refused) {
    return refused(api.reason);
  }
  if (web.kind === VibeOriginVerdict.Refused) {
    return refused(web.reason);
  }
  if (api.kind === VibeOriginKind.Loopback && web.kind === api.kind) {
    return {
      verdict: VibeOriginVerdict.Loopback,
      apiOrigin: api.origin,
      webOrigin: web.origin,
    };
  }
  if (
    api.kind === VibeOriginKind.BranchPreview &&
    web.kind === VibeOriginKind.BranchPreview
  ) {
    return pairPreviews(api, web);
  }
  return refused(
    "--api-origin and --web-origin must both be loopback or both be the same stage branch preview"
  );
}

const OriginRole = { Api: "api", Web: "web" } as const;
type OriginRole = (typeof OriginRole)[keyof typeof OriginRole];

const ROLE_FLAG: Record<OriginRole, string> = {
  [OriginRole.Api]: "--api-origin",
  [OriginRole.Web]: "--web-origin",
};

/** The Vercel project prefix each role's branch alias starts with. */
const ROLE_HOST_PREFIX: Record<OriginRole, string> = {
  [OriginRole.Api]: "api-stage-git-",
  [OriginRole.Web]: "app-stage-git-",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_DNS_LABEL_LENGTH = 63;
const BRANCH_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

type ClassifiedOrigin =
  | { readonly kind: typeof VibeOriginKind.Loopback; readonly origin: string }
  | {
      readonly kind: typeof VibeOriginKind.BranchPreview;
      readonly origin: string;
      readonly slug: string;
    }
  | {
      readonly kind: typeof VibeOriginVerdict.Refused;
      readonly reason: string;
    };

function classifyOrigin(value: string, role: OriginRole): ClassifiedOrigin {
  const flag = ROLE_FLAG[role];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refusedOrigin(`${flag} must be a URL, got ${value}`);
  }
  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    return refusedOrigin(`${flag} must be http(s), got ${url.protocol}`);
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    return { kind: VibeOriginKind.Loopback, origin: url.origin };
  }
  const slug = branchPreviewSlug(url.hostname, role);
  if (slug === null) {
    return refusedOrigin(
      `${flag} must be a loopback origin or https://${ROLE_HOST_PREFIX[role]}<branch>.${STAGE_PREVIEW_DOMAIN}, got ${url.hostname}`
    );
  }
  const extra = nonOriginPart(url);
  if (extra !== null) {
    return refusedOrigin(
      `${flag} must be exactly https://${url.hostname}, without ${extra}`
    );
  }
  return { kind: VibeOriginKind.BranchPreview, origin: url.origin, slug };
}

function branchPreviewSlug(hostname: string, role: OriginRole): string | null {
  const suffix = `.${STAGE_PREVIEW_DOMAIN}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const label = hostname.slice(0, -suffix.length);
  const prefix = ROLE_HOST_PREFIX[role];
  if (!label.startsWith(prefix) || label.length > MAX_DNS_LABEL_LENGTH) {
    return null;
  }
  const slug = label.slice(prefix.length);
  return BRANCH_SLUG.test(slug) ? slug : null;
}

/** What a preview URL carries beyond its bare HTTPS origin, if anything. */
function nonOriginPart(url: URL): string | null {
  const parts: [boolean, string][] = [
    [url.protocol !== "https:", "plain http"],
    [url.port !== "", "a port"],
    [url.username !== "" || url.password !== "", "userinfo"],
    [url.pathname !== "/", "a path"],
    [url.search !== "", "a query"],
    [url.hash !== "", "a fragment"],
  ];
  return parts.find(([present]) => present)?.[1] ?? null;
}

function pairPreviews(
  api: Extract<ClassifiedOrigin, { kind: typeof VibeOriginKind.BranchPreview }>,
  web: Extract<ClassifiedOrigin, { kind: typeof VibeOriginKind.BranchPreview }>
): VibeOriginDecision {
  if (api.slug !== web.slug) {
    return refused(
      `--api-origin and --web-origin name different branch previews (${api.slug} and ${web.slug})`
    );
  }
  return {
    verdict: VibeOriginVerdict.BranchPreview,
    apiOrigin: api.origin,
    webOrigin: web.origin,
    slug: api.slug,
  };
}

function refused(reason: string): VibeOriginDecision {
  return { verdict: VibeOriginVerdict.Refused, reason };
}

function refusedOrigin(reason: string): ClassifiedOrigin {
  return { kind: VibeOriginVerdict.Refused, reason };
}
