import { createMetadata } from "@repo/seo/metadata";
import { resolveDesktopBootstrapBrowserRun } from "@/lib/desktop-bootstrap-run";
import { createAuthPageMetadataGenerator } from "@/lib/og-metadata";
import { SignUpPageContent } from "../sign-up-page-content";

const DEFAULT_METADATA = createMetadata({
  title: "Create an account",
  description: "Enter your details to get started.",
});

// Unauthenticated visits to protected pages redirect here by default
// (FEA-632), so link-unfurler bots land on this page with a `redirect_url`
// back to the original document. Resolve that document's OG metadata so link
// previews show its real title instead of the generic sign-up metadata.
export const generateMetadata =
  createAuthPageMetadataGenerator(DEFAULT_METADATA);

const SignUpPage = async () => {
  const browserRun = await resolveDesktopBootstrapBrowserRun();

  return <SignUpPageContent browserRun={browserRun} />;
};

export default SignUpPage;
