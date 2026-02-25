import type { Metadata } from "next";
import { generateArtifactMetadata } from "@/lib/artifact-metadata";

type OgPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: OgPageProps): Promise<Metadata> {
  const { slug } = await params;
  return generateArtifactMetadata(slug);
}

function OgPage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground text-sm">
        Sign in to view this content.
      </p>
    </main>
  );
}

export default OgPage;
