"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@repo/design-system/components/ui/sidebar";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useFavoriteProjects } from "@/hooks/queries/use-projects";

export function SidebarFavorites() {
  const { data: favorites = [] } = useFavoriteProjects();
  const pathname = usePathname();
  const [open, setOpen] = useState(true);

  if (favorites.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      <Collapsible onOpenChange={setOpen} open={open}>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center justify-between">
            <span>Favorites</span>
            <ChevronRightIcon
              className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
            />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarMenu>
            {favorites.map((project) => {
              const teamId = project.teams[0]?.id;
              if (!teamId) {
                return null;
              }
              const href = `/teams/${teamId}/projects/${project.id}`;
              const isActive = pathname === href;

              return (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton asChild isActive={isActive}>
                    <Link href={href}>
                      <FolderIcon />
                      <span>{project.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  );
}
