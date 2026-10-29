import merge from "lodash.merge";
import type { Metadata } from "next";
import { siteUrl } from "./site-url";

type MetadataGenerator = Omit<Metadata, "description" | "title"> & {
  title: string;
  description: string;
  image?: string;
  path?: string;
};

export const applicationName = "Closedloop.ai";
const author: Metadata["authors"] = {
  name: "Closedloop.ai",
  url: "https://closedloop.ai",
};
const publisher = "Closedloop.ai";
const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const createMetadata = ({
  title,
  description,
  image,
  path,
  ...properties
}: MetadataGenerator): Metadata => {
  const parsedTitle = `${title} | ${applicationName}`;
  const defaultMetadata: Metadata = {
    title: parsedTitle,
    description,
    applicationName,
    metadataBase: siteUrl(productionUrl),
    authors: [author],
    creator: author.name,
    formatDetection: {
      telephone: false,
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: parsedTitle,
    },
    openGraph: {
      title: parsedTitle,
      description,
      type: "website",
      siteName: applicationName,
      locale: "en_US",
    },
    publisher,
    twitter: {
      card: "summary_large_image",
    },
  };

  const metadata: Metadata = merge(defaultMetadata, properties);

  // Left root-relative so the host comes from `metadataBase` rather than a
  // second copy of it. Next resolves it there — but note the two tags do NOT
  // share a fallback: `openGraph.images` absolutizes via
  // `getSocialImageMetadataBaseFallback`, while an absent `metadataBase` leaves
  // this value relative. They agree wherever `metadataBase` is set, which on
  // Vercel is always.
  if (path && metadata.openGraph) {
    metadata.openGraph.url = path;
  }

  if (image && metadata.openGraph) {
    metadata.openGraph.images = [
      {
        url: image,
        width: 1200,
        height: 630,
        alt: title,
      },
    ];
  }

  return metadata;
};
