import type { HomePage } from "@repo/cms";
import { Button } from "@repo/design-system/components/ui/button";
import type { Dictionary } from "@repo/internationalization";
import { MoveRight, PhoneCall } from "lucide-react";
import Link from "next/link";
import { env } from "@/env";

type HeroProps = {
  cmsData?: HomePage["hero"] | null;
  dictionary: Dictionary;
};

export const Hero = ({ cmsData, dictionary }: HeroProps) => {
  // Use CMS data if available, otherwise fall back to dictionary
  const title = cmsData?.title ?? dictionary.web.home.meta.title;
  const description =
    cmsData?.description ?? dictionary.web.home.meta.description;
  const primaryButtonText = cmsData?.primaryButtonText ?? "Get in touch";
  const primaryButtonHref = cmsData?.primaryButtonHref ?? "/contact";
  const secondaryButtonText = cmsData?.secondaryButtonText ?? "Sign up";
  const secondaryButtonHref =
    cmsData?.secondaryButtonHref ?? env.NEXT_PUBLIC_APP_URL;

  return (
    <div className="w-full">
      <div className="container mx-auto">
        <div className="flex flex-col items-center justify-center gap-8 py-20 lg:py-40">
          <div className="flex flex-col gap-4">
            <h1 className="max-w-2xl text-center font-regular text-5xl tracking-tighter md:text-7xl">
              {title}
            </h1>
            <p className="max-w-2xl text-center text-lg text-muted-foreground leading-relaxed tracking-tight md:text-xl">
              {description}
            </p>
          </div>
          <div className="flex flex-row gap-3">
            <Button asChild className="gap-4" size="lg" variant="outline">
              <Link href={primaryButtonHref}>
                {primaryButtonText} <PhoneCall className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild className="gap-4" size="lg">
              <Link href={secondaryButtonHref}>
                {secondaryButtonText} <MoveRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
