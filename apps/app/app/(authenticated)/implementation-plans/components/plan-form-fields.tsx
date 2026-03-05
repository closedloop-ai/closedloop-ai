import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { getUserDisplayName } from "@/lib/user-utils";
import type { PlanSource } from "./plan-source";

type PrdSelectorProps = {
  prds: ArtifactWithWorkstream[];
  isLoading: boolean;
  selectedPrdId: string;
  onSelect: (id: string) => void;
};

export function PrdSelector({
  prds,
  isLoading,
  selectedPrdId,
  onSelect,
}: Readonly<PrdSelectorProps>) {
  const placeholder = isLoading ? "Loading PRDs..." : "Select a PRD";
  const isEmpty = prds.length === 0 && !isLoading;

  return (
    <Select onValueChange={onSelect} value={selectedPrdId}>
      <SelectTrigger id="source-prd">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {isEmpty ? (
          <div className="p-2 text-center text-muted-foreground text-sm">
            No PRDs available. Create a PRD first.
          </div>
        ) : null}
        {prds.map((prd) => (
          <SelectItem key={prd.id} value={prd.id}>
            {prd.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type ProjectSelectorProps = {
  projects: { id: string; name: string }[];
  isLoading: boolean;
  selectedProjectId: string;
  onSelect: (id: string) => void;
};

export function ProjectSelector({
  projects,
  isLoading,
  selectedProjectId,
  onSelect,
}: Readonly<ProjectSelectorProps>) {
  const placeholder = isLoading ? "Loading projects..." : "Select a project";
  const isEmpty = projects.length === 0 && !isLoading;

  return (
    <Select onValueChange={onSelect} value={selectedProjectId}>
      <SelectTrigger id="project">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {isEmpty ? (
          <div className="p-2 text-center text-muted-foreground text-sm">
            No projects available. Create a project first.
          </div>
        ) : null}
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type PlanPreviewProps = {
  source: PlanSource;
  title: string;
  fileName: string;
  targetRepo: string;
  targetBranch: string;
};

export function PlanPreview({
  source,
  title,
  fileName,
  targetRepo,
  targetBranch,
}: Readonly<PlanPreviewProps>) {
  return (
    <div className="rounded-md border bg-muted/50 p-3 text-sm">
      <p className="mb-1 font-medium">Plan will be created with:</p>
      <ul className="space-y-1 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Title:</span>{" "}
          {title || (
            <span className="text-muted-foreground italic">
              No title entered
            </span>
          )}
        </li>
        <li>
          <span className="font-medium text-foreground">File name:</span>{" "}
          {fileName || (
            <span className="text-muted-foreground italic">Auto-generated</span>
          )}
        </li>
        {source.approver ? (
          <li>
            <span className="font-medium text-foreground">Approver:</span>{" "}
            {getUserDisplayName(source.approver)}
          </li>
        ) : null}
        {targetRepo ? (
          <li>
            <span className="font-medium text-foreground">Target Repo:</span>{" "}
            {targetRepo}
          </li>
        ) : null}
        {targetBranch ? (
          <li>
            <span className="font-medium text-foreground">Target Branch:</span>{" "}
            {targetBranch}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
