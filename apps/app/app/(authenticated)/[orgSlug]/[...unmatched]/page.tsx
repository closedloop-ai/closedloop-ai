import { notFound } from "next/navigation";

/**
 * In-shell 404 for any org-scoped URL that matches no route.
 *
 * Without this, an unmatched `/{orgSlug}/...` URL matches nothing at all, so
 * Next serves its own built-in system 404 — outside the `(authenticated)`
 * layout, with no sidebar, no org context, and no way back into the product.
 * That is precisely the failure `(authenticated)/not-found.tsx` was written to
 * prevent, and its docstring says so; the boundary simply never fired for
 * unmatched URLs because nothing under `[orgSlug]` called `notFound()`.
 *
 * ISS-5011 walked a real URL into that hole — `/{orgSlug}/webhooks` was deleted
 * outright with no successor to forward to — so this closes it for that
 * bookmark and for every stale or mistyped org URL at once
 * (closedloop-ai-stage, PR #4501).
 *
 * A catch-all is the lowest-priority match in the App Router (static, then
 * dynamic, then catch-all), so it can only be reached once every real route has
 * declined the URL. `notFound()` raises to the nearest boundary, which is
 * `(authenticated)/not-found.tsx`, so the 404 renders inside the shell with the
 * correct HTTP status.
 */
export default function UnmatchedOrgRoutePage(): never {
  notFound();
}
