"use client";

import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import {
  type FlattenedArtifactRow,
  flattenAssociatedArtifacts,
} from "@repo/app/documents/editors/prds/detail/components/flatten-associated-artifacts";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import type {
  ArtifactRowEditController,
  ArtifactRowEditInput,
} from "@repo/app/documents/hooks/use-artifact-row-edit";
import { useUpdateDocument } from "@repo/app/documents/hooks/use-documents";
import { endpointToDocument } from "@repo/app/documents/lib/artifact-row-adapter";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { useMemo, useState } from "react";

type AssociatedArtifactsSectionProps = {
  prdId: string;
  active?: boolean;
};

/**
 * Flat, always-expanded list of all Documents transitively produced by a PRD —
 * typically Features at depth 1 and their Plans at depth 2, but renders
 * any depth so that future downstream doc types appear automatically.
 * Parent/child relationships are conveyed purely through indentation.
 */
export function AssociatedArtifactsSection({
  prdId,
  active = true,
}: Readonly<AssociatedArtifactsSectionProps>) {
  const [isOpen, setIsOpen] = useState(true);

  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(prdId, {
    enabled: active,
    direction: LinkDirection.Target,
    linkType: LinkType.Produces,
    mode: LinkQueryMode.Tree,
  });

  const flattened = useMemo(
    () => flattenAssociatedArtifacts(prdId, resolvedLinks),
    [prdId, resolvedLinks]
  );

  return (
    <div className="bg-background">
      <SectionHeader
        isOpen={isOpen}
        onToggle={() => setIsOpen((prev) => !prev)}
        title="Associated Artifacts"
      />
      {isOpen && (
        <AssociatedArtifactsBody active={active} flattened={flattened} />
      )}
    </div>
  );
}

type AssociatedArtifactsBodyProps = {
  flattened: FlattenedArtifactRow[];
  active?: boolean;
};

function AssociatedArtifactsBody({
  flattened,
  active = true,
}: Readonly<AssociatedArtifactsBodyProps>) {
  if (flattened.length === 0) {
    return (
      <p className="py-3 text-base text-muted-foreground">
        No associated features yet. Generate features from this PRD to get
        started.
      </p>
    );
  }
  // The edit wiring stays in a child so the empty-list return above can run
  // without fetching the org roster or subscribing a mutation.
  return <EditableArtifactRows active={active} flattened={flattened} />;
}

function EditableArtifactRows({
  flattened,
  active = true,
}: Readonly<AssociatedArtifactsBodyProps>) {
  const updateArtifact = useUpdateDocument();
  const { data: orgUsers } = useOrganizationUsers({ enabled: active });

  // ISS-8543. Reading the list is when you know what you want to change about
  // it, so each child row's status, assignee and priority commit from here.
  // `mutateAsync` rather than `mutate`: the row's rollback is driven by the
  // rejection, and `mutate` never rejects, so a refused write would leave the
  // new value on screen. The shared QueryClient still toasts the failure.
  //
  // The controller is handed over WHOLE even while `orgUsers` is undefined —
  // loading, or failed. Only the assignee picker wants the roster; status and
  // priority want nothing but `commit`, and gating all three on `/users` made a
  // failed roster read silently disable the whole feature for the page's
  // lifetime. `useArtifactRowEdit` withholds just the picker instead.
  const editing = useMemo(
    () => ({
      users: orgUsers,
      commit: (input: ArtifactRowEditInput) =>
        updateArtifact.mutateAsync(input),
    }),
    [orgUsers, updateArtifact.mutateAsync]
  );

  return <ArtifactRows editing={editing} flattened={flattened} />;
}

function ArtifactRows({
  editing,
  flattened,
}: Readonly<
  AssociatedArtifactsBodyProps & { editing: ArtifactRowEditController }
>) {
  const deleteArtifactLink = useDeleteArtifactLink();
  return (
    <div className="flex flex-col border-t">
      {flattened.map((row) => (
        <ArtifactRow
          artifact={endpointToDocument(row.endpoint)}
          depth={row.depth}
          editing={editing}
          key={row.endpoint.id}
          linkId={row.linkId}
          onDetach={(id) => deleteArtifactLink.mutate(id)}
        />
      ))}
    </div>
  );
}
