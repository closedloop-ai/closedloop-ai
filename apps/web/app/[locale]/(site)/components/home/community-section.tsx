const communityBullets = [
  "Open source at the core, not locked behind a vendor roadmap",
  "Builders contribute, extend, and shape the system together",
  "Shared workflows and patterns improve across the community",
  "Works across Claude, Codex, and future models. No lock-in",
];

export const CommunitySection = () => {
  return (
    <section className="mx-auto w-full max-w-[1300px] px-6 py-16 md:px-10 md:py-24">
      <div className="max-w-3xl">
        <h2 className="text-balance font-semibold text-4xl tracking-tight md:text-5xl">
          This isn&apos;t just a product. It&apos;s a shift in how software gets
          built.
        </h2>
        <p className="mt-6 text-balance text-lg text-muted-foreground">
          Closedloop.ai is built on an open source core so teams control how
          they build with AI. Workflows, patterns, and systems evolve through
          the community, not vendor lock-in or model constraints.
        </p>
      </div>
      <div className="mt-12 grid gap-3 md:grid-cols-2">
        {communityBullets.map((item) => (
          <div
            className="flex gap-3 rounded-2xl border border-border/60 bg-card/60 p-5"
            key={item}
          >
            <span
              aria-hidden="true"
              className="mt-2 inline-block size-1.5 shrink-0 rounded-full bg-primary"
            />
            <span className="text-sm md:text-base">{item}</span>
          </div>
        ))}
      </div>
      <p className="mt-10 font-medium text-lg">
        Join a community of builders rethinking how teams work with AI.
      </p>
    </section>
  );
};
