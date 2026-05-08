import { Button } from "@repo/design-system/components/ui/button";
import type { Dictionary } from "@repo/internationalization";
import { MoveRight } from "lucide-react";
import { env } from "@/env";

type CTAProps = {
  dictionary: Dictionary;
};

export const CTA = ({ dictionary }: CTAProps) => {
  const d = dictionary.web.developers.cta;

  return (
    <div className="relative w-full py-20 lg:py-40">
      <div className="pointer-events-none absolute bottom-0 left-1/2 h-[400px] w-[600px] -translate-x-1/2 rounded-full bg-indigo-500/5 blur-3xl" />
      <div className="container mx-auto">
        <div className="flex flex-col items-center gap-8 rounded-md bg-muted p-8 text-center lg:p-14">
          <div className="flex flex-col gap-2">
            <h3 className="max-w-xl font-bold text-3xl tracking-tighter md:text-5xl">
              {d.title}
            </h3>
            <p className="max-w-xl text-lg text-muted-foreground leading-relaxed">
              {d.description}
            </p>
          </div>
          <div className="flex flex-row gap-4">
            <Button asChild className="gap-2" size="lg">
              <a href="#installation">
                {d.primaryButton} <MoveRight className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild className="gap-2" size="lg" variant="outline">
              <a
                href={
                  env.NEXT_PUBLIC_DOCS_URL ??
                  "https://github.com/closedloop-ai/claude-plugins"
                }
                rel="noopener noreferrer"
                target="_blank"
              >
                {d.secondaryButton}
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
