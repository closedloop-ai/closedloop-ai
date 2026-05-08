import { createPageMetadata, siteDescription } from "@/lib/site";
import { ArtifactsSection } from "./components/home/artifacts-section";
import { ControlVisibilitySection } from "./components/home/control-visibility-section";
import { FinalCtaSection } from "./components/home/final-cta-section";
import { HeroSection } from "./components/home/hero-section";
import { HowItWorksSection } from "./components/home/how-it-works-section";
import { SystemVisualSection } from "./components/home/system-visual-section";
import { TeamSection } from "./components/home/team-section";
import { TokenMaxingSection } from "./components/home/token-maxing-section";

type HomePageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export const generateMetadata = async () =>
  createPageMetadata(
    "The workspace for team-based agentic software development",
    siteDescription
  );

const HomePage = async ({ params }: HomePageProps) => {
  const { locale } = await params;

  return (
    <div className="flex w-full flex-col">
      <HeroSection />
      <SystemVisualSection />
      <TeamSection />
      <ArtifactsSection />
      <HowItWorksSection />
      <ControlVisibilitySection />
      <TokenMaxingSection />
      {/* CommunitySection — hidden for now; lives at ./components/home/community-section.tsx. Re-import and render between TokenMaxingSection and FinalCtaSection to bring it back. */}
      <FinalCtaSection locale={locale} />
    </div>
  );
};

export default HomePage;
