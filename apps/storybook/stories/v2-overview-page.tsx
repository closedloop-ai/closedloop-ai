import type { ReactNode } from "react";

// The Overview page that opens Composites, Patterns and Surfaces.
// Each root says what it holds; the "How the three work together"
// section is the same on all three, so it is written once here. The rules
// are in TAXONOMY.md, "The page tree".

export type V2PageTreeLevel = "Composites" | "Patterns" | "Surfaces";

const LEVELS: readonly {
  level: V2PageTreeLevel;
  is: string;
  sits: string;
}[] = [
  {
    level: "Composites",
    is: "A section of a page, with real content.",
    sits: "Under the page that uses it.",
  },
  {
    level: "Patterns",
    is: "A page's shell or layout, with every region empty and named.",
    sits: "At the page's own path.",
  },
  {
    level: "Surfaces",
    is: "A finished page: one pattern filled with composites.",
    sits: "At its path in the page tree.",
  },
];

const EXAMPLE_PAGE = "Artifacts/Branches/Branch Detail";

const EXAMPLE: readonly {
  level: V2PageTreeLevel;
  title: string;
  role: string;
}[] = [
  {
    level: "Patterns",
    title: `Patterns/${EXAMPLE_PAGE}`,
    role: "The layout: header, tabs and the comments rail, empty.",
  },
  {
    level: "Composites",
    title: `Composites/${EXAMPLE_PAGE}/…`,
    role: "Its own sections, such as the Branch Sessions Timeline Panel.",
  },
  {
    level: "Composites",
    title: "Composites/Shared/Artifact Detail/…",
    role: "Sections every artifact detail page shares, such as the Activity Timeline.",
  },
  {
    level: "Surfaces",
    title: `Surfaces/${EXAMPLE_PAGE}`,
    role: "The finished page: the pattern with those sections in its regions.",
  },
];

const RULES: readonly ReactNode[] = [
  <>
    <span className="font-medium text-foreground">One page tree.</span> Surfaces
    defines the pages. Composites and Patterns use the same tree, with a Shared
    group at the top.
  </>,
  <>
    <span className="font-medium text-foreground">
      The same path is the same page.
    </span>{" "}
    A page's layout, sections and finished page sit at the same path in each
    root.
  </>,
  <>
    <span className="font-medium text-foreground">
      A composite sits under the deepest page all its users share.
    </span>{" "}
    Used only on Session Detail: under Session Detail. Used on the Sessions list
    and Session Detail: under Sessions. Used in more than one part of the tree:
    under Shared, in a group named for the kind of page.
  </>,
  <>
    <span className="font-medium text-foreground">
      Whole pages live only in Surfaces.
    </span>{" "}
    A composed page is never a composite, and a pattern never shows content.
  </>,
  <>
    <span className="font-medium text-foreground">
      Foundations and Primitives are not placed by page.
    </span>{" "}
    They are the tokens and single elements every composite and pattern is built
    from.
  </>,
];

function LevelCard({
  level,
  current,
}: {
  level: (typeof LEVELS)[number];
  current: boolean;
}) {
  return (
    <article
      aria-current={current ? "page" : undefined}
      className={`flex-1 space-y-1 rounded-lg border p-4 ${
        current ? "border-primary bg-primary/5" : "bg-card"
      }`}
    >
      <h3 className="font-medium">
        {level.level}
        {current ? (
          <span className="ml-2 font-normal text-muted-foreground text-xs">
            (this section)
          </span>
        ) : null}
      </h3>
      <p className="text-muted-foreground text-sm">{level.is}</p>
      <p className="text-muted-foreground text-xs">{level.sits}</p>
    </article>
  );
}

function Arrow({ children }: { children: string }) {
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-center text-muted-foreground text-xs sm:flex-col"
    >
      <span className="text-lg leading-none">→</span>
      <span>{children}</span>
    </div>
  );
}

export function V2OverviewPage({
  current,
  title,
  intro,
  goesHere,
  doesNotGoHere,
}: {
  current: V2PageTreeLevel;
  title: string;
  intro: string;
  goesHere: readonly { term: string; description: string }[];
  doesNotGoHere: readonly { term: string; description: string }[];
}) {
  const [composites, patterns, surfaces] = LEVELS;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <header className="space-y-2">
        <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
          {current}
        </p>
        <h1 className="font-semibold text-3xl tracking-tight">{title}</h1>
        <p className="max-w-2xl text-muted-foreground text-sm">{intro}</p>
      </header>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl tracking-tight">What goes here</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
          {goesHere.map((item) => (
            <li key={item.term}>
              <span className="font-medium text-foreground">{item.term}</span>:{" "}
              {item.description}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl tracking-tight">
          What does not go here
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
          {doesNotGoHere.map((item) => (
            <li key={item.term}>
              <span className="font-medium text-foreground">{item.term}</span>:{" "}
              {item.description}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="font-semibold text-xl tracking-tight">
          How the three work together
        </h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          {composites && patterns && surfaces ? (
            <>
              <div className="flex flex-1 flex-col gap-2">
                <LevelCard current={current === "Patterns"} level={patterns} />
                <LevelCard
                  current={current === "Composites"}
                  level={composites}
                />
              </div>
              <Arrow>fill</Arrow>
              <LevelCard current={current === "Surfaces"} level={surfaces} />
            </>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">
          Composites and patterns are built from Primitives and Foundations.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-xl tracking-tight">
          One page, three roots
        </h2>
        <p className="text-muted-foreground text-sm">
          Branch Detail, as it appears in each root:
        </p>
        <dl className="divide-y rounded-lg border">
          {EXAMPLE.map((row) => (
            <div
              className={`grid gap-1 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4 ${
                row.level === current ? "bg-primary/5" : ""
              }`}
              key={row.title}
            >
              <dt className="break-words font-mono text-xs">{row.title}</dt>
              <dd className="text-muted-foreground text-sm">{row.role}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl tracking-tight">The rules</h2>
        <ul className="list-disc space-y-2 pl-5 text-muted-foreground text-sm">
          {RULES.map((rule, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list that never reorders
            <li key={index}>{rule}</li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          The full rules are in <code>apps/storybook/TAXONOMY.md</code>, "The
          page tree". <code>validate:catalog</code> fails the build when a
          composite has no place in the tree.
        </p>
      </section>
    </div>
  );
}
