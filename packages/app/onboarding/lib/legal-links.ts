import {
  LEGAL_PRIVACY_PATH,
  LEGAL_TERMS_PATH,
} from "../../shared/lib/legal-links";

const TRAILING_SLASH = /\/$/;

/**
 * The marketing origin the legal pages are served from when this bundle carries
 * no `NEXT_PUBLIC_WEB_URL` — which is every desktop renderer build, where
 * `process` does not exist at all.
 *
 * It must stay a host `isAllowedExternalUrl`
 * (`apps/desktop/src/main/settings/external-url-allowlist.ts`) admits, or the
 * `target="_blank"` anchor in the welcome step is silently denied by
 * `setWindowOpenHandler` instead of opening in the system browser.
 */
export const DEFAULT_WEB_ORIGIN = "https://closedloop.ai";

/**
 * ISS-11397: the onboarding dialog's legal links must be ABSOLUTE.
 *
 * The dialog renders in `apps/app` (which does not serve the marketing routes)
 * and in the desktop renderer (where a root-relative href resolves against the
 * `app://` scheme and reaches bundled assets only), so a root-relative
 * `/legal/privacy` 404s on both. `apps/app/app/layout.tsx` builds the URLs it
 * hands Clerk from the same variable, and `new URL(path, origin)` here matches
 * how it composes them.
 *
 * It is the same VARIABLE, not the same value on every deploy: `layout.tsx`
 * reads the schema-validated `env.NEXT_PUBLIC_WEB_URL`, which
 * `packages/next-config/keys.ts` routes through `getDynamicUrl`, so on a Vercel
 * PREVIEW build that one resolves to the per-branch web host while this reads
 * the configured value. `packages/app` cannot import an app's `env`, and a
 * preview-only host difference between two links to the same document is a
 * smaller defect than the 404 both of them used to be.
 *
 * Read at call time and guarded on `typeof process`, the way
 * `resolveWorkspaceUrlPrefix` is, because this module bundles into a renderer
 * that has no `process` global.
 */
export function resolveWebOrigin(): string {
  const configured =
    typeof process === "undefined"
      ? undefined
      : process.env.NEXT_PUBLIC_WEB_URL;
  return (configured || DEFAULT_WEB_ORIGIN).replace(TRAILING_SLASH, "");
}

/**
 * A malformed configured origin falls back rather than throwing: this runs in a
 * default parameter during render, so a `new URL` throw would take the whole
 * onboarding modal down over a misconfigured variable, which is a worse failure
 * than a link pointing at production.
 */
function legalHref(path: string): string {
  try {
    return new URL(path, resolveWebOrigin()).toString();
  } catch {
    return new URL(path, DEFAULT_WEB_ORIGIN).toString();
  }
}

export function privacyPolicyHref(): string {
  return legalHref(LEGAL_PRIVACY_PATH);
}

export function termsOfServiceHref(): string {
  return legalHref(LEGAL_TERMS_PATH);
}
