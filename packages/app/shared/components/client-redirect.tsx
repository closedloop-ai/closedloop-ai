"use client";

import { useNavigation } from "@repo/navigation/use-navigation";
import { useEffect } from "react";

type ClientRedirectProps = {
  href: string;
};

export function ClientRedirect({ href }: Readonly<ClientRedirectProps>) {
  const navigation = useNavigation();

  useEffect(() => {
    navigation.replace(href);
  }, [href, navigation]);

  return null;
}
