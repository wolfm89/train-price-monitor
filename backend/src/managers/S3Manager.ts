import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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
}
