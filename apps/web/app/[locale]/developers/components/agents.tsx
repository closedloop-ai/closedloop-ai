import type { Dictionary } from "@repo/internationalization";

type AgentsProps = {
  dictionary: Dictionary;
};

export const Agents = ({ dictionary }: AgentsProps) => {
  const d = dictionary.web.developers.agents;

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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {d.items.map((item) => (
              <div
                className="flex flex-col gap-2 rounded-lg border bg-card/70 p-5 transition-colors hover:border-border/80"
                key={item.name}
              >
                <code className="font-mono text-purple-400 text-sm">
                  {item.name}
                </code>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
