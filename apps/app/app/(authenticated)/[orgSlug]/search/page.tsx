import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Header } from "../../components/header";
import { SearchResults } from "./components/search-results";

type SearchPageProperties = {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{
    q?: string;
    tagId?: string;
  }>;
};

export const generateMetadata = async ({
  searchParams,
}: SearchPageProperties): Promise<Metadata> => {
  const { q, tagId } = await searchParams;

  if (tagId) {
    return {
      title: "Tagged documents - Search results",
      description: "Documents filtered by tag",
    };
  }

  return {
    title: `${q ?? ""} - Search results`,
    description: `Search results for ${q ?? ""}`,
  };
};

export default async function SearchPage({
  params,
  searchParams,
}: SearchPageProperties) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);

  if (!(sp.q || sp.tagId)) {
    redirect(`/${orgSlug}/my-tasks`);
  }

  return (
    <>
      <Header breadcrumbs={[{ label: "Search" }]} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
        <SearchResults />
      </div>
    </>
  );
}
