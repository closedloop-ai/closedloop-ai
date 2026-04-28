import { Button } from "@repo/design-system/components/ui/button";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { env } from "@/env";
import { localize } from "@/lib/site";
import { NewsletterForm } from "./newsletter-form";

type FinalCtaSectionProps = {
  locale: string;
};

export const FinalCtaSection = ({ locale }: FinalCtaSectionProps) => {
  return (
    <section className="mx-auto w-full max-w-[1300px] px-6 pt-12 pb-24 md:px-10">
      <div className="rounded-3xl bg-gradient-to-br from-primary/10 via-card/60 to-card p-8 shadow-xl md:p-12">
        <div className="max-w-3xl">
          <h3 className="font-semibold text-2xl tracking-tight md:text-3xl">
            Start building with your team today
          </h3>
          <p className="mt-6 text-balance text-lg text-muted-foreground">
            Move from isolated AI sessions to a shared system your whole team
            can rely on. Start with the hosted version or explore the docs to
            learn how it works.
          </p>
          <div className="mt-8 flex flex-col flex-wrap gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href={`${env.NEXT_PUBLIC_APP_URL}/sign-up`}>
                Start building
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={localize(locale, "/docs")}>Read the docs</Link>
            </Button>
          </div>
        </div>
        <div className="mt-12 max-w-2xl border-border/60 border-t pt-8">
          <p className="font-medium text-lg">
            Join our mailing list to learn how the best teams are building with
            AI
          </p>
          <div className="mt-5">
            <NewsletterForm />
          </div>
        </div>
      </div>
    </section>
  );
};
