import { marketing } from "@repo/cms";
import { getDictionary } from "@repo/internationalization";
import { createMetadata } from "@repo/seo/metadata";
import type { Metadata } from "next";
import { CTA } from "./components/cta";
import { FAQ } from "./components/faq";
import { Features } from "./components/features";
import { Hero } from "./components/hero";

type HomeProps = {
  params: Promise<{
    locale: string;
  }>;
};

export const generateMetadata = async ({
  params,
}: HomeProps): Promise<Metadata> => {
  const { locale } = await params;
  const dictionary = await getDictionary(locale);

  return createMetadata(dictionary.web.home.meta);
};

const Home = async ({ params }: HomeProps) => {
  const { locale } = await params;
  const dictionary = await getDictionary(locale);

  // Try to fetch CMS content, fall back to null if it fails
  const cmsHome = await marketing.getHomePage().catch(() => null);

  return (
    <>
      <Hero cmsData={cmsHome?.hero} dictionary={dictionary} />
      <Features cmsData={cmsHome?.features} dictionary={dictionary} />
      <FAQ cmsData={cmsHome?.faq} dictionary={dictionary} />
      <CTA cmsData={cmsHome?.cta} dictionary={dictionary} />
    </>
  );
};

export default Home;
