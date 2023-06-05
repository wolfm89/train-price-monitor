import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class S3Manager {
  private s3: S3Client;

  constructor() {
    // Initialize the S3 client
    this.s3 = new S3Client({ region: process.env.AWS_REGION });
  }

  async upload(bucketName: string, filename: string, file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    const cmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: filename,
      Body: Buffer.from(arrayBuffer),
    });
    await this.s3.send(cmd);
  }

  async getPresignedUrl(bucketName: string, filename: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: bucketName, Key: filename });
    return getSignedUrl(this.s3, cmd, { expiresIn: 86400 });
  }

  async deleteFilesWithPrefix(bucketName: string, prefix: string): Promise<void> {
    const listParams = {
      Bucket: bucketName,
      Prefix: prefix,
    };

    const objects = await this.s3.send(new ListObjectsV2Command(listParams));

    if (objects.Contents && objects.Contents.length > 0) {
      const deleteParams = {
        Bucket: bucketName,
        Delete: {
          Objects: objects.Contents.map((obj) => ({ Key: obj.Key })),
        },
      };

      await this.s3.send(new DeleteObjectsCommand(deleteParams));
    }
  }
}
