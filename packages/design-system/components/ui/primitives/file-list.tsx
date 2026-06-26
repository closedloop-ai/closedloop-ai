import { FolderOpen } from "lucide-react";

type FileListProps = {
  paths: string[];
};

export function FileList({ paths }: FileListProps) {
  if (paths.length === 0) {
    return <p className="text-[11px] text-muted-foreground italic">No files</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/80 shadow-sm">
      <div className="border-border/60 border-b bg-muted/35 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        Files
      </div>
      <div className="max-h-80 overflow-auto p-2">
        <div className="space-y-1.5">
          {paths.map((path) => (
            <div
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
              key={path}
            >
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="break-all font-mono text-[11px] text-foreground">
                {path}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
