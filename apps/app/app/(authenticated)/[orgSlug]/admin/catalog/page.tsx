import { redirect } from "next/navigation";

type PageProps = {
  readonly params: Promise<{ orgSlug: string }>;
};

/**
 * Legacy Packs home (FEA-4087).
 *
 * The admin catalog moved to the top-level, capability-driven `/packs` page,
 * where the admin/member split lives inside one route. This alias keeps old
 * bookmarks and the existing "Packs" breadcrumb working by redirecting to the
 * new home instead of silently 404-ing. The catalog authoring surface itself
 * (create / upload / distribute / archive) still renders under `/packs` via the
 * admin treatment — only the URL moved.
 */
export default async function CatalogAdminPage({ params }: PageProps) {
  const { orgSlug } = await params;
  redirect(`/${orgSlug}/packs`);
}
