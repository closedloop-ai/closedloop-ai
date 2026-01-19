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
