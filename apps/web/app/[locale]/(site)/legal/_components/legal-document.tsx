import type { ReactNode } from "react";

export function LegalDocument({
  children,
  lastUpdated,
  title,
}: {
  children: ReactNode;
  lastUpdated: string;
  title: string;
}) {
  return (
    <article className="mx-auto w-full max-w-4xl space-y-10 px-6 py-12 md:px-10">
      <header className="space-y-3">
        <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
          Legal
        </p>
        <h1 className="font-semibold text-4xl tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm">
          Last updated: {lastUpdated}
        </p>
      </header>
      <div className="space-y-8 text-muted-foreground leading-7">
        {children}
      </div>
    </article>
  );
}

export function LegalSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-foreground text-xl tracking-tight">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function LegalSubsection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium text-foreground">{title}</h3>
      {children}
    </div>
  );
}

export function LegalConfirmation({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md bg-muted p-4 text-foreground text-sm leading-6">
      {children}
    </p>
  );
}
