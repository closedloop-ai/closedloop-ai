import type { Metadata } from "next";
import { LoopDetailContainer } from "./loop-detail-container";

type LoopDetailPageProps = {
  params: Promise<{ id: string }>;
};

// SSR/loading fallback only. The loop's real name comes from client-loaded data
// (its artifact title), so `LoopDetailContainer` names the live browser tab via
// `document.title` once the loop resolves — mirroring the breadcrumb label so
// several open loop tabs stay distinguishable.
export const metadata: Metadata = {
  title: "Loop",
  description: "Loop execution details",
};

export default async function LoopDetailPage({ params }: LoopDetailPageProps) {
  const { id } = await params;

  return <LoopDetailContainer id={id} />;
}
