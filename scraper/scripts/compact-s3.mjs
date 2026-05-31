import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { parquetReadObjects } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';
import fs from 'fs';
import path from 'path';

const region = process.env.AWS_REGION || 'eu-central-1';
const s3 = new S3Client({ region });

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

async function getBucketName() {
  if (process.env.SCRAPER_BUCKET_NAME) {
    return process.env.SCRAPER_BUCKET_NAME;
  }
  const res = await s3.send(new ListBucketsCommand({}));
  const bucket = res.Buckets.find((b) => b.Name.startsWith('scraperstack-scraperdata'));
  if (!bucket) {
    throw new Error('Could not find ScraperData S3 bucket in the account.');
  }
  return bucket.Name;
}

function rowsToParquet(rows) {
  return parquetWriteBuffer({
    columnData: [
      { name: 'observed_at', type: 'TIMESTAMP', data: rows.map((r) => new Date(r.observed_at)) },
      { name: 'service_class', type: 'INT32', data: Int32Array.from(rows.map((r) => r.service_class)) },
      { name: 'route_id', type: 'STRING', data: rows.map((r) => r.route_id) },
      { name: 'origin_eva', type: 'STRING', data: rows.map((r) => r.origin_eva) },
      { name: 'origin_name', type: 'STRING', data: rows.map((r) => r.origin_name) },
      { name: 'dest_eva', type: 'STRING', data: rows.map((r) => r.dest_eva) },
      { name: 'dest_name', type: 'STRING', data: rows.map((r) => r.dest_name) },
      {
        name: 'departure_planned',
        type: 'TIMESTAMP',
        data: rows.map((r) => new Date(r.departure_planned)),
      },
      { name: 'arrival_planned', type: 'TIMESTAMP', data: rows.map((r) => new Date(r.arrival_planned)) },
      { name: 'train_type', type: 'STRING', data: rows.map((r) => r.train_type) },
      { name: 'train_number', type: 'STRING', data: rows.map((r) => r.train_number) },
      { name: 'transfers', type: 'INT32', data: Int32Array.from(rows.map((r) => r.transfers)) },
      { name: 'duration_minutes', type: 'INT32', data: Int32Array.from(rows.map((r) => r.duration_minutes)) },
      { name: 'days_to_departure', type: 'DOUBLE', data: Float64Array.from(rows.map((r) => r.days_to_departure)) },
      { name: 'fare_lowest_eur', type: 'DOUBLE', data: Float64Array.from(rows.map((r) => r.fare_lowest_eur)) },
      {
        name: 'load_factor',
        type: 'STRING',
        nullable: true,
        data: rows.map((r) => r.load_factor || null),
      },
    ],
  });
}

// -----------------------------------------------------------------------------
// Main Execution
// -----------------------------------------------------------------------------

async function main() {
  console.log('Starting S3 Price Data Compaction...');
  const bucketName = await getBucketName();
  console.log(`Target S3 Bucket identified: ${bucketName}`);

  // 1. List all objects in S3
  let allKeys = [];
  let continuationToken = null;

  do {
    const listParams = {
      Bucket: bucketName,
      Prefix: 'prices/',
      ...(continuationToken && { ContinuationToken: continuationToken }),
    };
    const listRes = await s3.send(new ListObjectsV2Command(listParams));
    if (listRes.Contents) {
      allKeys.push(...listRes.Contents.map((c) => c.Key));
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  console.log(`Found total S3 keys: ${allKeys.length}`);

  // 2. Filter for old files (contain underscores, do not start with batch_)
  const oldFiles = allKeys.filter((key) => {
    const filename = path.basename(key);
    return filename.includes('_') && !filename.startsWith('batch_');
  });

  console.log(`Found old-format files: ${oldFiles.length}`);
  if (oldFiles.length === 0) {
    console.log('No old-format files found. S3 is already clean!');
    return;
  }

  // 3. Group by daily partition folder
  const partitions = new Map();
  for (const key of oldFiles) {
    const dir = path.dirname(key);
    if (!partitions.has(dir)) {
      partitions.set(dir, []);
    }
    partitions.get(dir).push(key);
  }

  console.log(`Identified partitions to compact: ${partitions.size}`);

  // 4. Compact each partition
  for (const [partition, files] of partitions.entries()) {
    console.log(`\nCompacting partition: ${partition}/ (${files.length} files)...`);
    const allRows = [];

    // Download and parse all old files in this partition
    for (const key of files) {
      try {
        const getRes = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
        const bytes = await getRes.Body.transformToByteArray();
        const fileBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

        // Parse rows using hyparquet
        const data = await parquetReadObjects({ file: fileBuffer });
        allRows.push(...data);
      } catch (err) {
        console.error(`Error reading ${key}:`, err.message);
        throw new Error(`Aborting compaction for partition ${partition} due to error reading ${key}: ${err.message}`);
      }
    }

    if (allRows.length === 0) {
      console.log(`Skipping empty partition: ${partition}`);
      continue;
    }

    console.log(`Merged ${allRows.length} rows for partition ${partition}. Writing aggregated Parquet...`);

    try {
      // Serialize to Parquet
      const newBuffer = rowsToParquet(allRows);

      // Construct new batch key
      const epoch = Math.floor(Date.now() / 1000);
      const randomSuffix = Math.floor(Math.random() * 1000000).toString(36);
      const newKey = `${partition}/batch_${epoch}_${randomSuffix}.parquet`;

      // Upload consolidated file
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: newKey,
          Body: new Uint8Array(newBuffer),
          ContentType: 'application/octet-stream',
        })
      );
      console.log(`Uploaded consolidated batch file: ${newKey}`);

      // Delete the old individual files
      console.log(`Deleting ${files.length} old files from ${partition}...`);

      // DeleteObjects API takes max 1000 objects per call
      const batchSize = 1000;
      for (let i = 0; i < files.length; i += batchSize) {
        const deleteBatch = files.slice(i, i + batchSize).map((k) => ({ Key: k }));
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: deleteBatch, Quiet: true },
          })
        );
      }
      console.log(`Successfully compacted and cleaned partition ${partition}`);
    } catch (err) {
      console.error(`Failed to complete compaction for partition ${partition}:`, err.message);
    }
  }

  console.log('\nS3 Compaction complete. All files are now in consolidated batch format!');
}

main().catch((err) => {
  console.error('Fatal Error during S3 compaction:', err);
  process.exit(1);
});
