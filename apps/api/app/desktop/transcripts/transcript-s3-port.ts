import {
  abortTranscriptMultipartUpload,
  completeTranscriptMultipartUpload,
  copyTranscriptPart,
  createTranscriptMultipartUpload,
  headTranscriptObject,
  listTranscriptParts,
  presignTranscriptPutObject,
  presignTranscriptUploadPart,
} from "@repo/aws/transcript-storage";

/** S3 seam, injectable so unit tests run against a fake instead of real S3. */
export type TranscriptS3Port = {
  createMultipartUpload: typeof createTranscriptMultipartUpload;
  copyPart: typeof copyTranscriptPart;
  presignUploadPart: typeof presignTranscriptUploadPart;
  presignPutObject: typeof presignTranscriptPutObject;
  listParts: typeof listTranscriptParts;
  completeMultipartUpload: typeof completeTranscriptMultipartUpload;
  headObject: typeof headTranscriptObject;
  abortMultipartUpload: typeof abortTranscriptMultipartUpload;
};

export const defaultS3Port: TranscriptS3Port = {
  createMultipartUpload: createTranscriptMultipartUpload,
  copyPart: copyTranscriptPart,
  presignUploadPart: presignTranscriptUploadPart,
  presignPutObject: presignTranscriptPutObject,
  listParts: listTranscriptParts,
  completeMultipartUpload: completeTranscriptMultipartUpload,
  headObject: headTranscriptObject,
  abortMultipartUpload: abortTranscriptMultipartUpload,
};
