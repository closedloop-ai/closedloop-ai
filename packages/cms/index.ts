import { basehub as basehubClient, fragmentOn } from "basehub";
import { keys } from "./keys";
import "./basehub.config";

const basehub = basehubClient({
  token: keys().BASEHUB_TOKEN,
});

/* -------------------------------------------------------------------------------------------------
 * Common Fragments
 * -----------------------------------------------------------------------------------------------*/

const imageFragment = fragmentOn("BlockImage", {
  url: true,
  width: true,
  height: true,
  alt: true,
  blurDataURL: true,
});

/* -------------------------------------------------------------------------------------------------
 * Blog Fragments & Queries
 * -----------------------------------------------------------------------------------------------*/

const postMetaFragment = fragmentOn("BlogPostComponent", {
  _slug: true,
  _title: true,
  authors: {
    _title: true,
    image: imageFragment,
    x: true,
  },
  categories: true,
  publishedAt: true,
  description: true,
  image: {
    dark: imageFragment,
    light: imageFragment,
  },
});

const postFragment = fragmentOn("BlogPostComponent", {
  ...postMetaFragment,
  body: {
    plainText: true,
    json: {
      content: true,
      toc: true,
    },
    readingTime: true,
  },
});

export type PostMeta = fragmentOn.infer<typeof postMetaFragment>;
export type Post = fragmentOn.infer<typeof postFragment>;

export const blog = {
  postsQuery: fragmentOn("Query", {
    site: {
      blog: {
        posts: {
          items: postMetaFragment,
        },
      },
    },
  }),

  latestPostQuery: () =>
    fragmentOn("Query", {
      site: {
        blog: {
          posts: {
            __args: {
              orderBy: "_sys_createdAt__DESC",
            },
            item: postFragment,
          },
        },
      },
    }),

  postQuery: (slug: string) =>
    fragmentOn("Query", {
      site: {
        blog: {
          posts: {
            __args: {
              filter: {
                _sys_slug: { eq: slug },
              },
            },
            item: postFragment,
          },
        },
      },
    }),

  getPosts: async (): Promise<PostMeta[]> => {
    const data = await basehub.query(blog.postsQuery);

    return data.site.blog.posts.items;
  },

  getLatestPost: async (): Promise<Post | null> => {
    const data = await basehub.query(blog.latestPostQuery());

    return data.site.blog.posts.item;
  },

  getPost: async (slug: string): Promise<Post | null> => {
    const query = blog.postQuery(slug);
    const data = await basehub.query(query);

    return data.site.blog.posts.item;
  },
};

/* -------------------------------------------------------------------------------------------------
 * Legal Fragments & Queries
 * -----------------------------------------------------------------------------------------------*/

// TODO: Uncomment when LegalPagesItem content type is added to BaseHub
// const legalPostMetaFragment = fragmentOn("LegalPagesItem", {
//   _slug: true,
//   _title: true,
//   description: true,
// });

// const legalPostFragment = fragmentOn("LegalPagesItem", {
//   ...legalPostMetaFragment,
//   body: {
//     plainText: true,
//     json: {
//       content: true,
//       toc: true,
//     },
//     readingTime: true,
//   },
// });

// export type LegalPostMeta = fragmentOn.infer<typeof legalPostMetaFragment>;
// export type LegalPost = fragmentOn.infer<typeof legalPostFragment>;

// export const legal = {
//   postsQuery: fragmentOn("Query", {
//     legalPages: {
//       items: legalPostFragment,
//     },
//   }),

//   latestPostQuery: fragmentOn("Query", {
//     legalPages: {
//       __args: {
//         orderBy: "_sys_createdAt__DESC",
//       },
//       item: legalPostFragment,
//     },
//   }),

//   postQuery: (slug: string) =>
//     fragmentOn("Query", {
//       legalPages: {
//         __args: {
//           filter: {
//             _sys_slug: { eq: slug },
//           },
//         },
//         item: legalPostFragment,
//       },
//     }),

//   getPosts: async (): Promise<LegalPost[]> => {
//     const data = await basehub.query(legal.postsQuery);

//     return data.legalPages.items;
//   },

//   getLatestPost: async (): Promise<LegalPost | null> => {
//     const data = await basehub.query(legal.latestPostQuery);

//     return data.legalPages.item;
//   },

//   getPost: async (slug: string): Promise<LegalPost | null> => {
//     const query = legal.postQuery(slug);
//     const data = await basehub.query(query);

//     return data.legalPages.item;
//   },
// };

/* -------------------------------------------------------------------------------------------------
 * Marketing Pages Fragments & Queries
 * -----------------------------------------------------------------------------------------------*/

// NOTE: Requires HomePage content type to be created in BaseHub workspace first
// See PR description for required schema structure

const homePageQuery = fragmentOn("Query", {
  // @ts-expect-error - homepage content type must be created in BaseHub first
  homepage: {
    _id: true,
    hero: {
      title: true,
      description: true,
      primaryButtonText: true,
      primaryButtonHref: true,
      secondaryButtonText: true,
      secondaryButtonHref: true,
    },
    cases: {
      title: true,
      logos: {
        items: {
          image: imageFragment,
          alt: true,
          href: true,
        },
      },
    },
    features: {
      title: true,
      description: true,
      items: {
        items: {
          title: true,
          description: true,
          icon: true,
        },
      },
    },
    stats: {
      title: true,
      description: true,
      items: {
        items: {
          title: true,
          metric: true,
          delta: true,
          type: true,
        },
      },
    },
    testimonials: {
      title: true,
      items: {
        items: {
          title: true,
          description: true,
          authorName: true,
          authorImage: imageFragment,
        },
      },
    },
    faq: {
      title: true,
      description: true,
      ctaText: true,
      items: {
        items: {
          question: true,
          answer: true,
        },
      },
    },
    cta: {
      title: true,
      description: true,
      secondaryDescription: true,
      primaryButtonText: true,
      primaryButtonHref: true,
      secondaryButtonText: true,
      secondaryButtonHref: true,
    },
  },
});

type HomePageQueryResult = fragmentOn.infer<typeof homePageQuery>;
// @ts-expect-error - homepage will exist once BaseHub content type is created
export type HomePage = NonNullable<HomePageQueryResult["homepage"]>;

export const marketing = {
  getHomePage: async () => {
    try {
      const result = await basehub.query(homePageQuery);
      // @ts-expect-error - homepage will exist once BaseHub content type is created
      return result.homepage;
    } catch (error) {
      console.warn(
        "BaseHub homepage query failed, using static fallback",
        error
      );
      return null;
    }
  },
};
