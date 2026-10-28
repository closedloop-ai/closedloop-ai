import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { documentRowFromArtifact } from "@repo/app/documents/lib/artifact-row-adapter";

/** The project fields a row carries, by project id. */
export type ProjectsById = ReadonlyMap<string, DocumentRowData["project"]>;

/**
 * ISS-10472 — the board's document rows, built from the TREE rather than from
 * `GET /documents`.
 *
 * This is what lets the list view stop reading `/documents`, and it is not an
 * optimisation. Once the tree is paged by root group, the page's roots are
 * whichever ones the server selected — and `/documents` returns its own
 * created_at-ordered window, so a root on a later page need not appear in it at
 * all. `treeEntityToRowItem` returns `null` for a DOCUMENT it cannot find in
 * that window, and `groupByProjectTree` then SKIPS the row: the board would
 * render fewer rows than its own footer promises, and on a deep page
 * potentially none.
 *
 * `collectDocumentRowsFromTree` cannot serve this: it takes ONE project for
 * every row, and the assigned tree spans every project the viewer has work in.
 * The project is resolved per artifact instead.
 *
 * A row whose project is not in `projectsById` still renders — with its project
 * cell empty rather than the row dropped. An assigned artifact can legitimately
 * carry no project at all (`project_id` is nullable for every type, FEA-1749),
 * and a missing project is not a reason to hide someone's task.
 */
export function treeDocumentRows(
  tree: ProjectTreeResponse | null | undefined,
  projectsById: ProjectsById
): DocumentRowData[] {
  // Falsy, not `=== null`. `pruneBranchSubtrees` returns its argument
  // unchanged when absent and carries BOTH shapes — the tree source's contract
  // says `null`, while the query hook underneath it holds `undefined` until the
  // first response lands. Narrowing on `=== null` alone threw there once
  // already, and its docstring records why.
  if (!tree) {
    return [];
  }
  const seen = new Set<string>();
  const rows: DocumentRowData[] = [];
  for (const node of tree.nodes) {
    for (const artifact of [node.root, ...node.children]) {
      if (seen.has(artifact.id)) {
        continue;
      }
      seen.add(artifact.id);
      const row = documentRowFromArtifact(
        artifact,
        artifact.projectId === null
          ? null
          : (projectsById.get(artifact.projectId) ?? null)
      );
      if (row) {
        rows.push(row);
      }
    }
  }
  return rows;
}
