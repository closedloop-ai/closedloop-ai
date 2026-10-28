/**
 * ISS-10645: the caption a summary KPI card shows while its read is still in
 * flight, on EVERY listing.
 *
 * Sessions has said "Loading…" under its labelled cards since ISS-4429; Branches
 * said "Loading". One word, no ellipsis, and the operator saw it as two
 * different products. A listing's own nouns belong to that listing; this
 * sentence is about the read, so it is one value.
 */
export const LIST_SUMMARY_LOADING_DETAIL = "Loading…";
