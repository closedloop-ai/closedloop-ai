import { createMetadata } from "@repo/seo/metadata";
import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { headers } from "next/headers";
import { resolveOgMetadata } from "@/lib/og-metadata";

const SignIn = dynamic(() =>
  import("@repo/auth/components/sign-in").then((mod) => mod.SignIn)
);

type SignInPageProps = {
  searchParams: Promise<{ redirect_url?: string }>;
};

const DEFAULT_METADATA = createMetadata({
  title: "Welcome back",
  description: "Enter your details to sign in.",
});

/**
 * Generates metadata for the sign-in page. When a `redirect_url` query
 * parameter is present (set by Clerk's auth redirect), resolves OG metadata
 * for the original page so link unfurler bots see the correct title/description
 * instead of the generic "Welcome back" sign-in metadata.
 */
export async function generateMetadata({
  searchParams,
}: SignInPageProps): Promise<Metadata> {
  const { redirect_url } = await searchParams;

  if (redirect_url) {
    try {
      const parsed = new URL(redirect_url);
      const headersList = await headers();
      const host = headersList.get("host");

      if (host && parsed.host === host && parsed.pathname.length > 1) {
        return resolveOgMetadata(parsed.pathname.slice(1));
      }
    } catch {
      // redirect_url is a relative path
      const path = redirect_url.split("?")[0];
      if (path.startsWith("/") && path.length > 1) {
        return resolveOgMetadata(path.slice(1));
      }
    }
  }

  return DEFAULT_METADATA;
}

const SignInPage = () => <SignIn />;

export default SignInPage;
