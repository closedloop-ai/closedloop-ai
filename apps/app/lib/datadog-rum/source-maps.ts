/**
 * ISS-7766: browser source maps for Datadog RUM.
 *
 * RUM stack traces are captured against the shipped (minified) bundle, so a
 * production error frame reads `t.qa` at a column offset into a one-line chunk.
 * That is why ISS-7493 could name seven error buckets and identify the code
 * behind only one of them — and why one bucket is reported as `pendingComment`
 * undefined, an identifier that appears nowhere in this repo's source. ISS-9849
 * traced that bucket to `@liveblocks/react-tiptap`, so the name is a
 * dependency's own property rather than the mangled name assumed here before.
 *
 * Uploading the maps to Datadog, keyed on the same `service` + `version` the
 * RUM SDK reports, makes Datadog symbolicate every frame automatically.
 *
 * This is OPT-IN and OFF by default. Emitting the maps costs build time and
 * output size, and the upload needs a `DD_API_KEY` that only the deploy
 * environment has, so a build that cannot upload should not pay for maps it
 * would only delete.
 *
 * `DD_`, not `DATADOG_`: every Datadog variable this estate sets already uses
 * that prefix — `DD_API_KEY`/`DD_SITE`/`DD_SERVICE`/`DD_ENV` on all six Vercel
 * projects, the ECS task definitions, and the GitHub Actions secrets. The
 * credential this needs is therefore ALREADY set on the app projects, and one
 * prefix keeps it that way. `datadog-ci` insists on its own spelling for the
 * key, which the uploader translates at that one boundary.
 */

export type BrowserSourceMapEnv = {
  readonly DD_SOURCEMAP_UPLOAD?: string | undefined;
  readonly VERCEL?: string | undefined;
  // Index signature so `process.env` (NodeJS.ProcessEnv) is assignable —
  // without it TS's weak-type check rejects a type whose only member is
  // optional.
  readonly [key: string]: string | undefined;
};

/** The single opt-in switch. Both the emit and the upload read this. */
export const DD_SOURCEMAP_UPLOAD_FLAG = "DD_SOURCEMAP_UPLOAD";

/**
 * Whether `next build` should emit browser source maps.
 *
 * Deliberately the SAME condition the uploader gates on, so the two cannot
 * drift into "maps emitted but never uploaded" (dead build cost, and `.map`
 * files sitting in publicly served `.next/static`) or "upload runs with no maps
 * to send" (a silently empty upload that still reports success).
 *
 * ISS-8925: never on Vercel, whatever the flag says. Vercel publishes its own
 * copy of `.next/static` before any post-build step can run, so "emit, upload,
 * then delete" deletes a directory that is no longer the one being served — the
 * strip reported 299 files removed and verified the directory empty while 299
 * maps were live on `app.closedloop.ai`. And what it publishes is effectively
 * permanent: served `immutable` with a one-year max-age, it survived a redeploy
 * from a map-free build, `edge-cache/purge-all`, deleting the deployments, and
 * `vercel cache purge --type cdn`. There is no delete that can win that race, so
 * the emit does not happen where the platform decides what ships. Maps for
 * Datadog are produced somewhere Vercel does not publish, or not at all.
 */
export function shouldEmitBrowserSourceMaps(env: BrowserSourceMapEnv): boolean {
  if (env.VERCEL) {
    return false;
  }
  return env[DD_SOURCEMAP_UPLOAD_FLAG] === "true";
}
