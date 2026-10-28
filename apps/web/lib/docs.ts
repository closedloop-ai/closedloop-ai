import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { publicPathname } from "./public-pathname";

export function getDocsSource(locale: string) {
  return loader({
    baseUrl: publicPathname(`/${locale}/docs`),
    source: docs.toFumadocsSource(),
  });
}
