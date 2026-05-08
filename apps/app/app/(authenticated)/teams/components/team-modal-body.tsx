"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { MembersTabContent } from "./members-tab-content";
import { TeamRepositoriesSection } from "./team-repositories-section";
import { type TeamModalState, TeamModalTab } from "./use-team-modal";

type TeamModalBodyProps = {
  state: TeamModalState;
};

export function TeamModalBody({ state }: TeamModalBodyProps) {
  const {
    activeTab,
    error,
    name,
    setActiveTab,
    setName,
    showRepositoriesTab,
    team,
  } = state;

  const membersTab = <MembersTabContent state={state} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
      <div className="grid gap-2">
        <Label htmlFor="team-name">Team Name</Label>
        <Input
          autoFocus
          id="team-name"
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Engineering, Design, Product"
          required
          value={name}
        />
      </div>

      <Separator />

      {showRepositoriesTab ? (
        <Tabs
          className="flex min-h-[340px] flex-1 flex-col"
          onValueChange={(value) => setActiveTab(value as TeamModalTab)}
          value={activeTab}
        >
          <TabsList>
            <TabsTrigger value={TeamModalTab.Members}>Members</TabsTrigger>
            <TabsTrigger value={TeamModalTab.Repositories}>
              Repositories
            </TabsTrigger>
          </TabsList>
          <TabsContent
            className="mt-4 flex min-h-0 flex-1 flex-col"
            value={TeamModalTab.Members}
          >
            {membersTab}
          </TabsContent>
          <TabsContent
            className="mt-4 flex min-h-0 flex-1 flex-col px-2"
            value={TeamModalTab.Repositories}
          >
            {team ? (
              <TeamRepositoriesSection
                enabled={activeTab === TeamModalTab.Repositories}
                state={state}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      ) : (
        membersTab
      )}

      {error ? (
        <p className="rounded-md border border-destructive/20 bg-destructive/10 p-2 text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
