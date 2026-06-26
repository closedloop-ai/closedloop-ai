"use client";

export type DiffHunk = {
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lines: string[];
};

type UnifiedDiffProps = {
  hunks: DiffHunk[];
};

export function UnifiedDiff({ hunks }: UnifiedDiffProps) {
  if (hunks.length === 0) {
    return <p className="text-[11px] text-muted-foreground italic">No diff</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-zinc-950/95 shadow-sm">
      <div className="max-h-96 overflow-auto">
        {hunks.map((hunk) => (
          <UnifiedDiffHunk
            hunk={hunk}
            key={`${hunk.oldStart}-${hunk.newStart}`}
          />
        ))}
      </div>
    </div>
  );
}

function UnifiedDiffHunk({ hunk }: { hunk: DiffHunk }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  return (
    <div>
      <div className="border-cyan-500/20 border-y bg-cyan-500/10 px-3 py-1 font-mono text-[10px] text-cyan-200">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      <table className="w-full border-collapse font-mono text-[11px]">
        <tbody>
          {hunk.lines.map((line) => {
            let kind: "add" | "remove" | "context" = "context";
            if (line.startsWith("+")) {
              kind = "add";
            } else if (line.startsWith("-")) {
              kind = "remove";
            }
            const content = line.slice(kind === "context" ? 0 : 1);
            const oldCell = kind === "add" ? "" : oldLine++;
            const newCell = kind === "remove" ? "" : newLine++;
            let rowClassName = "text-zinc-200";
            if (kind === "add") {
              rowClassName = "bg-emerald-500/10 text-emerald-100";
            } else if (kind === "remove") {
              rowClassName = "bg-red-500/10 text-red-100";
            }
            let sign = " ";
            if (kind === "add") {
              sign = "+";
            } else if (kind === "remove") {
              sign = "-";
            }

            return (
              <tr
                className={rowClassName}
                key={`diff-${oldCell}-${newCell}-${content.slice(0, 24)}`}
              >
                <td className="w-10 border-border/40 border-r px-2 text-right text-zinc-500">
                  {oldCell}
                </td>
                <td className="w-10 border-border/40 border-r px-2 text-right text-zinc-500">
                  {newCell}
                </td>
                <td className="w-4 px-1 text-center">{sign}</td>
                <td className="whitespace-pre-wrap break-words px-2 py-0.5">
                  {content}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
