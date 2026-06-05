import { getDictionary } from "@repo/internationalization";
import { createMetadata } from "@repo/seo/metadata";
import type { Metadata } from "next";
import { Agents } from "./components/agents";
import { Commands } from "./components/commands";
import { CTA } from "./components/cta";
import { Features } from "./components/features";
import { Hero } from "./components/hero";
import { Installation } from "./components/installation";

type DevelopersProps = {
  params: Promise<{
    locale: string;
  }>;
};

export const generateMetadata = async ({
  params,
}: DevelopersProps): Promise<Metadata> => {
  const { locale } = await params;
  const dictionary = await getDictionary(locale);

  return createMetadata(dictionary.web.developers.meta);
};

const Developers = async ({ params }: DevelopersProps) => {
  const { locale } = await params;
  const dictionary = await getDictionary(locale);

  return (
    <>
      <Hero dictionary={dictionary} />
      <Features dictionary={dictionary} />
      <Commands dictionary={dictionary} />
      <Agents dictionary={dictionary} />
      <Installation dictionary={dictionary} />
      <CTA dictionary={dictionary} />
    </>
  );
};

export default Developers;
