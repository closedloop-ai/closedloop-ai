"use client";

import type { HomePage } from "@repo/cms";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from "@repo/design-system/components/ui/carousel";
import type { Dictionary } from "@repo/internationalization";
import Image from "next/image";
import { useEffect, useState } from "react";

type CasesProps = {
  cmsData?: HomePage["cases"] | null;
  dictionary: Dictionary;
};

export const Cases = ({ cmsData, dictionary }: CasesProps) => {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);

  // Use CMS data if available, otherwise fall back to dictionary
  const title = cmsData?.title ?? dictionary.web.home.cases.title;
  const logos =
    cmsData?.logos?.items ??
    Array.from({ length: 15 }).map((_, index) => ({
      image: null,
      alt: `Logo ${index + 1}`,
      href: null,
    }));

  useEffect(() => {
    if (!api) {
      return;
    }

    setTimeout(() => {
      if (api.selectedScrollSnap() + 1 === api.scrollSnapList().length) {
        setCurrent(0);
        api.scrollTo(0);
      } else {
        api.scrollNext();
        setCurrent(current + 1);
      }
    }, 1000);
  }, [api, current]);

  return (
    <div className="w-full py-20 lg:py-40">
      <div className="container mx-auto">
        <div className="flex flex-col gap-10">
          <h2 className="text-left font-regular text-xl tracking-tighter md:text-5xl lg:max-w-xl">
            {title}
          </h2>
          <Carousel className="w-full" setApi={setApi}>
            <CarouselContent>
              {logos.map((logo, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Pre-existing pattern, items are static
                <CarouselItem className="basis-1/4 lg:basis-1/6" key={index}>
                  <div className="flex aspect-square items-center justify-center rounded-md bg-muted p-6">
                    {logo.image?.url ? (
                      <Image
                        alt={logo.alt ?? "Company logo"}
                        className="max-h-full max-w-full object-contain"
                        height={logo.image.height ?? 100}
                        src={logo.image.url}
                        width={logo.image.width ?? 100}
                      />
                    ) : (
                      <span className="text-sm">{logo.alt}</span>
                    )}
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
          </Carousel>
        </div>
      </div>
    </div>
  );
};
