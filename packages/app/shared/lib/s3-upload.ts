/**
 * Upload a file to S3 using a presigned URL.
 * Uses a raw fetch PUT — must NOT add Authorization headers (S3 presigned URLs
 * are already authenticated via query-string signature).
 */
export async function uploadToS3(
  presignedUrl: string,
  file: File,
  mimeType: string
): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: "PUT",
    body: file,
    headers: {
      "Content-Type": mimeType,
    },
  });

  if (!response.ok) {
    throw new Error(
      `S3 upload failed: ${response.status} ${response.statusText}`
    );
  }
}
