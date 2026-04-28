const steps = [
  {
    title: "Define requirements",
    description: "Capture what should be built as the first artifact",
  },
  {
    title: "Create implementation plans",
    description:
      "Agents generate structured plan artifacts grounded in your codebase",
  },
  {
    title: "Review and align",
    description:
      "Plan artifacts are edited and approved by product, design, and engineering",
  },
  {
    title: "Execute with agents",
    description:
      "Agents generate code artifacts using approved plans and shared context",
  },
  {
    title: "Monitor progress",
    description: "Execution artifacts stream updates in real time",
  },
  {
    title: "Validate and improve",
    description: "Artifacts are reviewed, evaluated, and feed into future runs",
  },
];

export const HowItWorksSection = () => {
  return (
    <section className="dark w-full bg-sidebar pb-16 text-foreground md:pb-24">
      <div className="mx-auto w-full max-w-[1300px] px-6 md:px-10">
        <div className="max-w-3xl">
          <h3 className="font-semibold text-xl tracking-tight md:text-2xl">
            Artifacts drive every step from idea to production
          </h3>
        </div>
        <ol className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {steps.map(({ description, title }, index) => (
            <li
              className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/60 p-6"
              key={title}
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-primary text-sm">
                  {index + 1}
                </span>
                <p className="font-medium text-lg">{title}</p>
              </div>
              <p className="text-muted-foreground text-sm">{description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
};
