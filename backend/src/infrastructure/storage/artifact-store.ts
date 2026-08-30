import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { env } from "../../config/env.js";

const client = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } });

export async function putArtifact(objectKey: string, body: Buffer, mimeType: string) {
  await client.send(new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: objectKey, Body: body, ContentType: mimeType }));
}

export async function getArtifact(objectKey: string, signal?: AbortSignal): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({ Bucket: env.MINIO_BUCKET, Key: objectKey }), { abortSignal: signal });
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
