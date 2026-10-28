"use client";

import {
  isWorkspaceMenuEntryRendered,
  WORKSPACE_MENU_ENTRY_LABEL,
  type WorkspaceMenuActor,
  type WorkspaceMenuCapabilities,
  WorkspaceMenuEntryId,
  type WorkspaceMenuWorkspaceSummary,
} from "@repo/api/src/types/workspace-menu";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { WorkspaceMenuAccountLabel } from "./workspace-menu-account-label";
import { ITEM_CLASSNAME, PANEL_CLASSNAME } from "./workspace-menu-styles";

/**
 * The Switch-workspace submenu, and the Create-a-workspace entry the prototype
 * nests under it.
 *
 * Rendered only when at least one of the two capabilities is `Ready`, so a host
 * that has neither — Desktop, which is single-org by construction — shows no
 * switcher affordance at all rather than an empty or disabled one.
 */

/**
 * Whether the switcher submenu renders at all. Exported because the menu body
 * decides where to state the signed-in address from the SAME predicate — two
 * predicates for one question is how the address ends up stated nowhere.
 */
export function hasSwitcherSubmenu(
  capabilities: WorkspaceMenuCapabilities
): boolean {
  return (
    isWorkspaceMenuEntryRendered(
      capabilities[WorkspaceMenuEntryId.SwitchWorkspace]
    ) ||
    isWorkspaceMenuEntryRendered(
      capabilities[WorkspaceMenuEntryId.CreateWorkspace]
    )
  );
}

export function WorkspaceSwitcherSubmenu({
  actor,
  activeWorkspaceId,
  capabilities,
  onCreateWorkspace,
  onSwitchWorkspace,
  workspaces,
}: {
  actor: WorkspaceMenuActor;
  activeWorkspaceId: string;
  capabilities: WorkspaceMenuCapabilities;
  onCreateWorkspace: () => void;
  onSwitchWorkspace: (workspace: WorkspaceMenuWorkspaceSummary) => void;
  workspaces: readonly WorkspaceMenuWorkspaceSummary[];
}) {
  const canSwitch = isWorkspaceMenuEntryRendered(
    capabilities[WorkspaceMenuEntryId.SwitchWorkspace]
  );
  const canCreate = isWorkspaceMenuEntryRendered(
    capabilities[WorkspaceMenuEntryId.CreateWorkspace]
  );

  if (!hasSwitcherSubmenu(capabilities)) {
    return null;
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={ITEM_CLASSNAME}>
        {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SwitchWorkspace]}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={`w-72 ${PANEL_CLASSNAME}`}>
        {actor.email ? <WorkspaceMenuAccountLabel actor={actor} /> : null}

        {canSwitch ? (
          <DropdownMenuRadioGroup value={activeWorkspaceId}>
            {workspaces.map((workspace) => (
              <DropdownMenuRadioItem
                className={ITEM_CLASSNAME}
                key={workspace.id}
                onSelect={() => onSwitchWorkspace(workspace)}
                value={workspace.id}
              >
                {/* Not a `PersonAvatar` (ISS-12343): the subject is a
                    workspace, not a person. */}
                <Avatar className="size-7 shrink-0 rounded-md">
                  {/* ISS-8972: always mounted, `src` possibly undefined —
                   * see table-cell-list-primitives.tsx's ReferenceChip for
                   * why. */}
                  <AvatarImage alt="" src={workspace.imageUrl ?? undefined} />
                  <AvatarFallback className="rounded-md text-xs">
                    {workspace.name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                {/* The NAME is what tells workspaces apart. The avatar reads as
                    texture at this size, so it never carries the distinction
                    alone. */}
                <span className="truncate font-medium">{workspace.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : null}

        {canCreate ? (
          <>
            <DropdownMenuLabel className="pt-3 text-muted-foreground">
              Account
            </DropdownMenuLabel>
            <DropdownMenuItem
              className={ITEM_CLASSNAME}
              onSelect={onCreateWorkspace}
            >
              {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateWorkspace]}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
