"use client";

import { PageNotFound } from "@repo/app/shared/components/page-not-found";

/**
 * In-shell 404 boundary for the authenticated app. A `notFound()` raised by any
 * route under this segment — e.g. the removed `/documents` index (FEA-3964) or a
 * flagged-off route reached by direct URL — lands here and renders inside the
 * sidebar chrome the layout provides.
 */
export default function AuthenticatedNotFound() {
  return <PageNotFound />;
}
