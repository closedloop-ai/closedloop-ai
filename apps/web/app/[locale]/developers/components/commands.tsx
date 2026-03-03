import type { Dictionary } from "@repo/internationalization";

type CommandsProps = {
  dictionary: Dictionary;
};

export const Commands = ({ dictionary }: CommandsProps) => {
  const d = dictionary.web.developers.commands;

  return (
    <div className="w-full bg-muted/50 py-20 lg:py-40">
      <div className="container mx-auto">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col items-center gap-4 text-center">
            <span className="font-semibold text-indigo-500 text-xs uppercase tracking-widest">
              {d.label}
            </span>
            <h2 className="max-w-xl font-bold text-3xl tracking-tighter md:text-5xl">
              {d.title}
            </h2>
            <p className="max-w-xl text-lg text-muted-foreground leading-relaxed">
              {d.description}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.items.map((item) => (
              <div
                className="flex items-center gap-4 rounded-lg border bg-card/70 px-5 py-4 transition-colors hover:border-border/80"
                key={item.name}
              >
                <code className="shrink-0 rounded-md bg-indigo-500/10 px-2.5 py-1 font-mono text-indigo-400 text-sm">
                  {item.name}
                </code>
                <span className="text-muted-foreground text-sm">
                  {item.description}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
