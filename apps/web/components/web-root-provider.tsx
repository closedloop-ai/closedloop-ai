"use client";

import { type Framework, FrameworkProvider } from "fumadocs-core/framework";
import { RootProvider } from "fumadocs-ui/provider/base";
import Image from "next/image";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { publicPathname } from "@/lib/public-pathname";

type WebRootProviderProps = {
  children: ReactNode;
};

const FrameworkImage = Image as Framework["Image"];
const FrameworkLink = Link as Framework["Link"];

function usePublicPathname(): string {
  const pathname = usePathname();

  // `rewriteDefault` prerenders the source route under its locale prefix, while the
  // browser hydrates its public, unprefixed URL. Fumadocs uses this value for
  // active navigation and footer neighbours, so both passes need one pathname.
  return publicPathname(pathname);
}

export function WebRootProvider({ children }: WebRootProviderProps) {
  return (
    <FrameworkProvider
      Image={FrameworkImage}
      Link={FrameworkLink}
      useParams={useParams}
      usePathname={usePublicPathname}
      useRouter={useRouter}
    >
      <RootProvider search={{ enabled: false }}>{children}</RootProvider>
    </FrameworkProvider>
  );
}
