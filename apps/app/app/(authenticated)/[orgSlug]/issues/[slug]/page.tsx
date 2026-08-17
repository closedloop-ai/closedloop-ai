import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveOgMetadata } from "@/lib/og-metadata";
// FEA-3955: the Issue detail editor subtree now lives here under
// `issues/[slug]/` (Phase 2 completed the FEA-4137 rename). This
// `/issues/[slug]` route is the canonical detail surface; the legacy
// `/features/[slug]` path redirects here (preserving deep-link/query params)
// via the proxy redirect in `apps/app/lib/app-route-redirects.ts`. ISS-4570:
// that redirect is 308 (permanent, as FEA-3955 specced) once the path already
// carries its org prefix, and 302 while it still has to inject the caller's.
import { IssueEditorContainer } from "./issue-editor-container";

type IssuePageProps = {
  params: Promise<{ orgSlug: string; slug: string }>;
  searchParams: Promise<{ version?: string }>;
};

export async function generateMetadata({
  params,
}: IssuePageProps): Promise<Metadata> {
  const { orgSlug, slug } = await params;
  return resolveOgMetadata(`${orgSlug}/issues/${slug}`);
}

export default async function IssuePage({
  params,
  searchParams,
}: Readonly<IssuePageProps>) {
  const { slug } = await params;
  const { version } = await searchParams;

  let versionNumber: number | undefined;
  if (version) {
    versionNumber = Number.parseInt(version, 10);
    if (Number.isNaN(versionNumber) || versionNumber < 1) {
      notFound();
    }
  }

  return <IssueEditorContainer slug={slug} version={versionNumber} />;
}
