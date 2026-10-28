// jsdom ships no types; this declares the members `markdown.ts` and the test fixtures use.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string);
    readonly window: {
      readonly document: Document;
      readonly DOMParser: typeof DOMParser;
    };
  }
}
