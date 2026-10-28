import { OptionsFilterContent } from "@repo/design-system/components/ui/filter-popover";
import { OptionsFilterContent as ForkOptionsFilterContent } from "@repo/design-system/components/ui/filter-popover-v2";
import { RangeFilterContent } from "@repo/design-system/components/ui/filter-range-submenu";
import { RangeFilterContent as ForkRangeFilterContent } from "@repo/design-system/components/ui/filter-range-submenu-v2";
import type { TableFiltersViewModel } from "@repo/design-system/components/ui/table-filters";
import { useFeatureFlagEnabledOptional } from "../../../shared/feature-flags/use-feature-flag-enabled";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";

type SessionsFacetGroup = NonNullable<
  TableFiltersViewModel["facetGroups"]
>[number];

export function renderSessionsHeaderFilterContent(
  filterViewModel: TableFiltersViewModel,
  columnId: string
) {
  const group = filterViewModel.facetGroups?.find(
    (candidate) => candidate.id === columnId
  );
  if (!group) {
    return null;
  }
  return <SessionsHeaderFilterGroupContent group={group} />;
}

function SessionsHeaderFilterGroupContent({
  group,
}: {
  group: SessionsFacetGroup;
}) {
  // ISS-12641: closed, the header filter renders the fork `main` rendered
  // before the merge onto the champion.
  const championControls = useFeatureFlagEnabledOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const Range = championControls ? RangeFilterContent : ForkRangeFilterContent;
  const Options = championControls
    ? OptionsFilterContent
    : ForkOptionsFilterContent;
  if (group.kind === "range") {
    return <Range clearLabel="Clear" group={group} />;
  }
  return (
    <Options
      emptyLabel={group.emptyLabel}
      onToggle={group.onToggle}
      options={group.options}
      searchPlaceholder={`Filter ${group.label.toLowerCase()}...`}
      selectedValues={group.selectedValues}
    />
  );
}
