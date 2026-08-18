"use client";

import { SearchTypeahead } from "@repo/app/search/components/search-typeahead";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useEffect, useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";

export const Search = () => {
  const orgSlug = useOrgSlug();
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const [value, setValue] = useState("");

  const activeQuery = searchParams.get(WEB_SEARCH_QUERY_PARAM) ?? "";
  const activeTagId = searchParams.get("tagId") ?? "";
  const isSearchRoute = pathname === `/${orgSlug}/search`;
  const hasActiveSearch = isSearchRoute && (!!activeQuery || !!activeTagId);
  const showClear = !!value || hasActiveSearch;

  useEffect(() => {
    if (isSearchRoute) {
      setValue(activeQuery);
      return;
    }

    setValue("");
  }, [activeQuery, isSearchRoute]);

  const resetSearch = () => {
    setValue("");

    if (hasActiveSearch) {
      navigation.replace(`/${orgSlug}/my-tasks`, { scroll: false });
    }
  };

  const handleSubmit = (submittedValue: string) => {
    const trimmed = submittedValue.trim();
    if (!trimmed) {
      resetSearch();
      return;
    }

    const params = new URLSearchParams({ [WEB_SEARCH_QUERY_PARAM]: trimmed });
    navigation.navigate(`/${orgSlug}/search?${params.toString()}`);
  };

  return (
    <SearchTypeahead
      nativeAction={`/${orgSlug}/search`}
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
