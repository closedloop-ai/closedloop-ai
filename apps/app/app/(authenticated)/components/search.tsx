"use client";

import { SearchTypeahead } from "@repo/app/search/components/search-typeahead";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useEffect, useState } from "react";
import { useNavOrgSlug } from "@/hooks/use-org-slug";

export const Search = () => {
  const orgSlug = useNavOrgSlug();
  // Targets that carry no payload — the no-JS form action, the reset — may take
  // the builder's org-relative form and let `apps/app/proxy.ts` resolve it to
  // the active org. A target carrying the user's QUERY does not: see the held
  // submit below.
  const buildOrgPath = useOrgPath();
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const [value, setValue] = useState("");
  const [pendingQuery, setPendingQuery] = useState("");

  const activeQuery = searchParams.get(WEB_SEARCH_QUERY_PARAM) ?? "";
  const activeTagId = searchParams.get("tagId") ?? "";
  // Matched by SHAPE rather than against a built path: an equality check against
  // the built path reads the search page as a non-search route during the
  // unresolved window, blanking the query the user is looking at. Still anchored
  // to one optional leading segment, so a document slugged "search"
  // (`/{org}/issues/search`) is not mistaken for the search route.
  const isSearchRoute = SEARCH_ROUTE_PATTERN.test(pathname);
  const hasActiveSearch = isSearchRoute && (!!activeQuery || !!activeTagId);
  const showClear = !!value || hasActiveSearch;

  useEffect(() => {
    if (isSearchRoute) {
      setValue(activeQuery);
      return;
    }

    setValue("");
  }, [activeQuery, isSearchRoute]);

  // ISS-7344: the shell paints before Clerk resolves the active org, and this box
  // is submit-on-Enter — a keypress is one-shot, so a submit dropped in that
  // window is dropped for good and the box reads as broken. HOLD the query
  // instead and send it the moment the org is known, so it reaches its org-scoped
  // destination in exactly one navigation rather than through a redirect hop.
  useEffect(() => {
    if (!(orgSlug && pendingQuery)) {
      return;
    }

    setPendingQuery("");
    navigation.navigate(searchHref(orgSlug, pendingQuery));
  }, [navigation, orgSlug, pendingQuery]);

  const resetSearch = () => {
    setValue("");
    setPendingQuery("");

    if (hasActiveSearch) {
      navigation.replace(buildOrgPath(MY_TASKS_PATH), { scroll: false });
    }
  };

  const handleSubmit = (submittedValue: string) => {
    const trimmed = submittedValue.trim();
    if (!trimmed) {
      resetSearch();
      return;
    }

    if (orgSlug) {
      navigation.navigate(searchHref(orgSlug, trimmed));
      return;
    }

    setPendingQuery(trimmed);
  };

  return (
    <SearchTypeahead
      nativeAction={buildOrgPath(SEARCH_PATH)}
      nativeInputName={WEB_SEARCH_QUERY_PARAM}
      nativeMethod="get"
      onClear={resetSearch}
      onSelectHit={() => setValue("")}
      onSubmit={handleSubmit}
      onValueChange={setValue}
      showClear={showClear}
      value={value}
    />
  );
};

const WEB_SEARCH_QUERY_PARAM = "q";
const SEARCH_PATH = "/search";
// `/{orgSlug}/search`, and the org-relative `/search` the proxy resolves to it.
const SEARCH_ROUTE_PATTERN = /^(?:\/[^/]+)?\/search$/;
const MY_TASKS_PATH = "/my-tasks";

function searchHref(orgSlug: string, query: string): string {
  const params = new URLSearchParams({ [WEB_SEARCH_QUERY_PARAM]: query });
  return `/${orgSlug}${SEARCH_PATH}?${params.toString()}`;
}
