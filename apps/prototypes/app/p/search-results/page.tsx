import { SearchSurfaceV2PageDemo } from "@repo/app/search/components/search-surface-v2-page-demo";
import { PrototypeShell } from "@repo/app/shell/v2/components/prototype-shell";

const SearchResultsPrototypePage = () => (
  <PrototypeShell breadcrumbs={[{ isCurrent: true, label: "Search" }]}>
    <SearchSurfaceV2PageDemo />
  </PrototypeShell>
);

export default SearchResultsPrototypePage;
