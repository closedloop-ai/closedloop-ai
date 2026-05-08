import Image from "next/image";

const tokenBullets = [
  {
    icon: "/illustrations/token-agents-in-parallel-v2.png",
    label:
      "Run multiple agent workflows in parallel instead of one session at a time",
  },
  {
    icon: "/illustrations/token-shared-context-v2.png",
    label: "Use shared context so agents don't restart from scratch each task",
  },
  {
    icon: "/illustrations/token-continuously-running-v2.png",
    label:
      "Keep agents working continuously across real features, bugs, and plans",
  },
  {
    icon: "/illustrations/token-different-models-v2.png",
    label:
      "Run work across different models and runtimes without manual switching.",
  },
];

export const TokenMaxingSection = () => {
  return (
    <section className="mx-auto w-full max-w-[1300px] px-6 pt-12 md:px-10 md:py-16">
      <div className="max-w-3xl space-y-5">
        <h2 className="text-balance font-semibold text-4xl tracking-tight md:text-5xl">
          You&apos;re paying for unused capacity
        </h2>
        <p className="text-lg text-muted-foreground">
          Most teams underutilize their AI subscriptions. ClosedLoop.ai keeps
          agents running on real work with the right context, so you
          consistently hit usage limits on productive tasks instead of wasting
          capacity on isolated sessions.
        </p>
      </div>
      <ul className="mt-12 grid gap-4 sm:grid-cols-2">
        {tokenBullets.map(({ icon, label }) => (
          <li
            className="flex items-center gap-5 rounded-2xl border border-border/60 bg-card/40 p-6"
            key={label}
          >
            <div className="relative size-16 shrink-0">
              <Image alt="" className="object-contain" fill src={icon} />
            </div>
            <span className="text-base md:text-lg">{label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};
