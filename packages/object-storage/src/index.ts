import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type ObjectStorageConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type ObjectMetadata = {
  contentLength: number;
  contentType?: string;
  etag?: string;
  metadata: Record<string, string>;
};

export type StoredObject = { key: string; sizeBytes: number; lastModified: Date | null };

export class ObjectStorage {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(config: ObjectStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists|already exists/i.test(message))
          throw error;
      }
    }
  }

  async createPresignedUpload(input: {
    key: string;
    contentType: string;
    sha256: string;
    expiresInSeconds?: number;
  }): Promise<{ url: string; headers: Record<string, string>; expiresInSeconds: number }> {
    const expiresInSeconds = input.expiresInSeconds ?? 15 * 60;
    const headers = {
      'content-type': input.contentType,
      'x-amz-meta-sha256': input.sha256.toLowerCase(),
    };
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        Metadata: { sha256: input.sha256.toLowerCase() },
      }),
      {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-type']),
        unhoistableHeaders: new Set(['x-amz-meta-sha256']),
      },
    );
    return { url, headers, expiresInSeconds };
  }

  async createPresignedDownload(key: string, expiresInSeconds = 5 * 60): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
      etag: response.ETag,
      metadata: response.Metadata ?? {},
    };
  }

  async getObjectBytes(key: string, maxBytes: number): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if ((response.ContentLength ?? 0) > maxBytes)
      throw new Error(`Object exceeds ${maxBytes} bytes`);
    if (!response.Body) throw new Error(`Object body is missing: ${key}`);
    const bytes = await response.Body.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new Error(`Object exceeds ${maxBytes} bytes`);
    return bytes;
  }

  async putObject(input: {
    key: string;
    body: Uint8Array | string;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async listObjects(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (!object.Key) continue;
        objects.push({
          key: object.Key,
          sizeBytes: object.Size ?? 0,
          lastModified: object.LastModified ?? null,
        });
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }
}
