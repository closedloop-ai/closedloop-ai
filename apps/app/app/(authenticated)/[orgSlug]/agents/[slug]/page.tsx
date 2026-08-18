import { normalizeAgentSlug } from "@repo/app/agents/lib/agent-slug-label";
import type { Metadata } from "next";
import { AgentDetailHeader } from "./agent-detail-header";
import { AgentDetailWithPromote } from "./agent-detail-with-promote";

type AgentDetailPageProps = {
  params: Promise<{ orgSlug: string; slug: string }>;
};

export const metadata: Metadata = {
  title: "Agent Detail",
  description: "View and edit agent details",
};

export default async function AgentDetailPage({
  params,
}: AgentDetailPageProps) {
  const { orgSlug, slug: rawSlug } = await params;
  // ISS-4776: normalize the route param ONCE at the boundary so the breadcrumb,
  // the detail fetch, and the token-trend fetch (all downstream of this slug)
  // key off the same value. A router hop can double-encode the segment
  // (`command%3A%3A%2F%2Fcl-ci-babysit`); without this the crumb would decode to
  // `//cl-ci-babysit` while the still-encoded slug reaching the API misses the
  // lookup and the body renders "not found" — the crumb and body disagreeing.
  const slug = normalizeAgentSlug(rawSlug);

  return (
    <>
      {/* The route param is the org-identity slug (`kind::key`). The last crumb
          should read like the name the user clicked — matching the
          Sessions/Branches routes — so it shows the resolved component name,
          falling back to the identity `key` rather than our internal `kind::`
          identity (`Agents >` is already the context and the kind is an eyebrow
          on the page). FEA-3977; ISS-5518 moved the crumb behind a client
          boundary because the name only exists after the detail read. */}
      <AgentDetailHeader orgSlug={orgSlug} slug={slug} />
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
        <AgentDetailWithPromote orgSlug={orgSlug} slug={slug} />
      </div>
    </>
  );
}
