import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Header } from "../components/header";
import { SearchResults } from "./components/search-results";

type SearchPageProperties = {
  searchParams: Promise<{
    q: string;
  }>;
};

export const generateMetadata = async ({
  searchParams,
}: SearchPageProperties): Promise<Metadata> => {
  const { q } = await searchParams;

  return {
    title: `${q} - Search results`,
    description: `Search results for ${q}`,
  };
};

export default async function SearchPage({
  searchParams,
}: SearchPageProperties) {
  const { q } = await searchParams;

  if (!q) {
    redirect("/");
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
