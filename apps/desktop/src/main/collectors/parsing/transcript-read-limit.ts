/**
 * FEA-3132 (B1): the largest transcript a whole-file read admits. Real
 * transcripts are a few MB; a file past this only ever is a runaway, and
 * buffering it would risk the db-host heap. Shared by the token extractor and
 * the fork-lineage scan (ISS-12552) so both refuse the same files.
 */
export const TRANSCRIPT_MAX_READ_BYTES = 200 * 1024 * 1024;
