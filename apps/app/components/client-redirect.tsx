"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

type ClientRedirectProps = {
  href: string;
};

export function ClientRedirect({ href }: Readonly<ClientRedirectProps>) {
  const router = useRouter();

  useEffect(() => {
    router.replace(href);
  }, [href, router]);

  return null;
}
