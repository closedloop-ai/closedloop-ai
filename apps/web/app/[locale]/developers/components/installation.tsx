import type { Dictionary } from "@repo/internationalization";

type InstallationProps = {
  dictionary: Dictionary;
};

export const Installation = ({ dictionary }: InstallationProps) => {
  const d = dictionary.web.developers.installation;

  return (
    <div className="w-full py-20 lg:py-40" id="installation">
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
          <div className="mx-auto max-w-2xl">
            {d.steps.map((step, index) => (
              <div className="mb-9 flex gap-5 last:mb-0" key={step.title}>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 font-semibold text-sm text-white">
                  {index + 1}
                </div>
                <div className="flex flex-col gap-2">
                  <h4 className="font-semibold text-lg">{step.title}</h4>
                  <p className="text-muted-foreground text-sm">
                    {step.description}
                  </p>
                  <div className="overflow-x-auto rounded-lg border bg-muted px-4 py-3">
                    <code className="font-mono text-indigo-300 text-sm">
                      {step.code}
                    </code>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
