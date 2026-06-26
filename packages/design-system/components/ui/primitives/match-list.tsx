import { Search } from "lucide-react";

export type GrepMatch = {
  file?: string;
  line?: number;
  text?: string;
};

type MatchListProps = {
  matches: GrepMatch[];
};

export function MatchList({ matches }: MatchListProps) {
  if (matches.length === 0) {
    return <p className="text-[11px] text-muted-foreground italic">No matches</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/80 shadow-sm">
      <div className="border-border/60 border-b bg-muted/35 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        Matches
      </div>
      <div className="max-h-80 overflow-auto p-2">
        <div className="space-y-1.5">
          {matches.map((match, index) => (
            <div
              className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
              key={`${match.file ?? "match"}-${match.line ?? index}-${index}`}
            >
              <div className="flex items-center gap-2 text-[11px]">
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
                {match.file ? (
                  <span className="break-all font-mono text-foreground">
                    {match.file}
                  </span>
                ) : null}
                {typeof match.line === "number" ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
                    {match.line}
                  </span>
                ) : null}
              </div>
              {match.text ? (
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                  {match.text}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
