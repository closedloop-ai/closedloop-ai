import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import type { ComponentType } from "react";
import { LivePage } from "./live-page";
import { LIVE_ORG_SLUG, type LiveRoute } from "./live-route";

/**
 * A live document route (`[orgSlug]/<segment>/[slug]/page.tsx`) as the browser
 * renders it: the route's editor container in the app frame. The page is a
 * server component that hands the container the slug and a valid `?version=`;
 * that is derived here from the URL the story is at.
 */
export function DocumentRoutePage({
  activePath,
  container: Container,
  slug,
}: {
  activePath: string;
  container: ComponentType<{ slug: string; version?: number }>;
  slug: string;
}) {
  const version = Number.parseInt(
    useSearchParamsValue().get("version") ?? "",
    10
  );
  return (
    <LivePage activePath={activePath}>
      <Container
        slug={slug}
        version={Number.isNaN(version) || version < 1 ? undefined : version}
      />
    </LivePage>
  );
}

/** The URL of a document route: `/<org>/<segment>/<slug>[?version=N]`. */
export function documentRoute(
  segment: string,
  slug: string,
  version?: number
): LiveRoute {
  const path = `/${LIVE_ORG_SLUG}/${segment}/${slug}`;
  return {
    params: { slug },
    path: version === undefined ? path : `${path}?version=${version}`,
  };
}
