import { createMetadata } from "@repo/seo/metadata";
import dynamic from "next/dynamic";
import { createAuthPageMetadataGenerator } from "@/lib/og-metadata";

const SignUp = dynamic(() =>
  import("@repo/auth/components/sign-up").then((mod) => mod.SignUp)
);

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

const SignUpPage = () => <SignUp />;

export default SignUpPage;
