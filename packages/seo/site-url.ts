/**
 * The site's absolute base, kept apart from `metadata.ts` because that module
 * imports `next` for its `Metadata` types, and `next/types/global.d.ts`
 * augments `NodeJS.ProcessEnv` to make `NODE_ENV` REQUIRED. Any program that
 * reaches this function through `metadata.ts` inherits that augmentation
 * globally — which is what broke `scripts/lint`'s Node-only `tsc` program, 30
 * errors across 12 files that pass plain object literals as a spawn `env`.
 * `siteUrl` needs nothing from `next`, so it does not have to carry it.
 */

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Resolve `VERCEL_PROJECT_PRODUCTION_URL` into the site's absolute base — what
 * relative images, `robots.txt`'s `Sitemap:` line, and every `sitemap.xml`
 * entry are built against. The one owner: a per-caller copy of this picks the
 * protocol off the value's own prefix, and a bare host does not start with
 * `https`, so it emits `http://` on an https-only site.
 *
 * Vercel sets it as a bare host, so the protocol has to be supplied. The
 * documented LOCAL value carries one already (`http://localhost:3001`), and
 * prepending a second yields `http://http://localhost:3001` — whose host parses
 * as `http`, so a relative `openGraph.images` entry resolves under a host that
 * does not exist. Take the value's own scheme when it has one.
 *
 * Unset yields `undefined` rather than a guessed host: Next falls back for
 * `metadataBase` with a build warning, and a caller that owes an absolute URL
 * has to say it cannot build one instead of naming somewhere it is not.
 */
export function siteUrl(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }

  return new URL(
    ABSOLUTE_URL_PATTERN.test(value) ? value : `${protocol}://${value}`
  );
}
