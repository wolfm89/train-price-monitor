import { Logger } from '@aws-lambda-powertools/logger';
import {
  S3Client,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { parquetReadObjects, parquetMetadata } from 'hyparquet';

import { type ParquetRow } from './types.js';
import { rowsToParquet } from './parquet.js';

const logger = new Logger({ serviceName: 'scraper-compactor' });
const s3 = new S3Client(process.env.AWS_ENDPOINT_URL ? { forcePathStyle: true } : {});

const BUCKET_NAME = process.env.SCRAPER_BUCKET_NAME!;

interface CompactorEvent {
  /** Optional date override in YYYY-MM-DD format (UTC). If omitted, yesterday is compacted. */
  dateOverride?: string;
}

export const handler = async (event?: CompactorEvent): Promise<void> => {
  let y: string;
  let m: string;
  let d: string;

  if (event?.dateOverride) {
    const parts = event.dateOverride.split('-');
    if (parts.length !== 3) {
      throw new Error(`Invalid dateOverride format: ${event.dateOverride}. Expected YYYY-MM-DD.`);
    }
    [y, m, d] = parts;
    logger.info('Using date override for S3 compaction', { dateOverride: event.dateOverride });
  } else {
    // Default to yesterday
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    y = String(yesterday.getUTCFullYear());
    m = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
    d = String(yesterday.getUTCDate()).padStart(2, '0');
    logger.info('Using default yesterday partition for S3 compaction', { date: `${y}-${m}-${d}` });
  }

  const prefix = `prices/year=${y}/month=${m}/day=${d}/`;
  logger.info('Scanning S3 partition', { bucket: BUCKET_NAME, prefix });

  // 1. List all objects in the daily partition, separating batch_ files and existing daily_ files
  const batchFiles: string[] = [];
  const dailyFiles: string[] = [];
  let continuationToken: string | undefined = undefined;

  while (true) {
    const listRes: ListObjectsV2CommandOutput = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (listRes.Contents) {
      for (const content of listRes.Contents) {
        if (content.Key) {
          const filename = content.Key.split('/').pop() || '';
          if (filename.startsWith('batch_')) {
            batchFiles.push(content.Key);
          } else if (filename.startsWith('daily_')) {
            dailyFiles.push(content.Key);
          }
        }
      }
    }

    if (!listRes.NextContinuationToken) {
      break;
    }
    continuationToken = listRes.NextContinuationToken;
  }

  logger.info('Scan complete', { batchFilesCount: batchFiles.length, dailyFilesCount: dailyFiles.length });

  if (batchFiles.length === 0) {
    logger.info('No new batch_ files found to compact. S3 partition is already clean and consolidated.');
    return;
  }

  // Combine both batch files and existing daily files to merge all rows into a single new daily file
  const oldFiles = [...batchFiles, ...dailyFiles];

  // 2. Download and parse all old files
  const allRows: ParquetRow[] = [];
  let expectedRowCount = 0;

  for (const key of oldFiles) {
    try {
      const getRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      if (!getRes.Body) {
        throw new Error(`Empty body returned for S3 object: ${key}`);
      }

      const bytes = await getRes.Body.transformToByteArray();
      // Slice ArrayBuffer exactly to correct byte size and cast to ArrayBuffer
      const fileBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

      // Extract metadata row count for independent validation
      const metadata = parquetMetadata(fileBuffer);
      expectedRowCount += Number(metadata.num_rows);

      // Parse rows
      const parsedData = await parquetReadObjects({ file: fileBuffer });

      for (const r of parsedData) {
        allRows.push({
          observed_at: new Date(r.observed_at as string | number),
          service_class: Number(r.service_class),
          route_id: String(r.route_id),
          origin_eva: String(r.origin_eva),
          origin_name: String(r.origin_name),
          dest_eva: String(r.dest_eva),
          dest_name: String(r.dest_name),
          departure_planned: new Date(r.departure_planned as string | number),
          arrival_planned: new Date(r.arrival_planned as string | number),
          train_type: String(r.train_type),
          train_number: String(r.train_number),
          transfers: Number(r.transfers),
          duration_minutes: Number(r.duration_minutes),
          days_to_departure: Number(r.days_to_departure),
          fare_lowest_eur: Number(r.fare_lowest_eur),
          load_factor: r.load_factor ? String(r.load_factor) : null,
        });
      }
    } catch (err) {
      logger.error('Failed to process old file', { key, err: String(err) });
      throw new Error(`Aborting compaction due to error processing ${key}: ${String(err)}`);
    }
  }

  // 3. Robust Verification Level 1: In-memory row count check
  if (allRows.length !== expectedRowCount) {
    throw new Error(
      `Verification failed (Level 1)! Merged rows count (${allRows.length}) does not match expected row count (${expectedRowCount}). Aborting deletion.`
    );
  }

  logger.info('Verification Level 1 passed', { rowCount: allRows.length });

  // 3b. De-duplicate rows in memory to resolve duplicate entries from concurrent retries
  const uniqueRowsMap = new Map<string, ParquetRow>();
  for (const r of allRows) {
    const key = `${r.observed_at.getTime()}_${r.route_id}_${r.service_class}_${r.departure_planned.getTime()}_${r.train_number}_${r.fare_lowest_eur}`;
    uniqueRowsMap.set(key, r);
  }
  const deduplicatedRows = Array.from(uniqueRowsMap.values());
  const duplicateCount = allRows.length - deduplicatedRows.length;
  if (duplicateCount > 0) {
    logger.info('Removed duplicate rows during compaction', {
      duplicateCount,
      originalCount: allRows.length,
      finalCount: deduplicatedRows.length,
    });
  }

  // 4. Serialize all rows into a single Parquet file
  let newBuffer: ArrayBuffer;
  try {
    newBuffer = rowsToParquet(deduplicatedRows);
  } catch (err) {
    logger.error('Failed to serialize merged rows to Parquet', { err: String(err) });
    throw new Error(`Aborting compaction: Parquet serialization failed: ${String(err)}`);
  }

  // 5. Robust Verification Level 2: Double-check the newly generated Parquet buffer
  const targetRowCount = deduplicatedRows.length;
  try {
    const verifiedData = await parquetReadObjects({ file: newBuffer });
    if (verifiedData.length !== targetRowCount) {
      throw new Error(
        `Verification failed (Level 2)! Parsed row count of generated Parquet file (${verifiedData.length}) does not match expected row count (${targetRowCount}).`
      );
    }
    logger.info('Verification Level 2 passed (generated buffer validated)', { parsedRows: verifiedData.length });
  } catch (err) {
    logger.error('Double-check validation failed', { err: String(err) });
    throw new Error(`Aborting compaction: Generated Parquet file failed validation: ${String(err)}`);
  }

  // 6. Upload the consolidated master file
  const epoch = Math.floor(Date.now() / 1000);
  const randomSuffix = Math.floor(Math.random() * 1000000).toString(36);
  const newKey = `${prefix}daily_${epoch}_${randomSuffix}.parquet`;

  logger.info('Uploading consolidated master Parquet file', { key: newKey });

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: newKey,
        Body: new Uint8Array(newBuffer),
        ContentType: 'application/octet-stream',
      })
    );
  } catch (err) {
    logger.error('Failed to upload consolidated file to S3', { key: newKey, err: String(err) });
    throw new Error(`Aborting compaction: Consolidated file upload failed: ${String(err)}`);
  }

  // 7. Delete the old individual files (only reached if all verifications passed)
  logger.info('Verification complete. Proceeding with deletion of original files', { count: oldFiles.length });

  const batchSize = 1000;
  for (let i = 0; i < oldFiles.length; i += batchSize) {
    const deleteBatch = oldFiles.slice(i, i + batchSize).map((k) => ({ Key: k }));
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: { Objects: deleteBatch, Quiet: true },
        })
      );
    } catch (err) {
      logger.error('Failed to delete batch of old files', { err: String(err) });
      throw new Error(
        `Partially successful compaction: Consolidated file written, but failed to clean up old files: ${String(err)}`
      );
    }
  }

  logger.info('S3 compaction complete successfully', {
    partition: prefix,
    originalFilesCleaned: oldFiles.length,
    consolidatedFile: newKey,
    totalRowsSaved: expectedRowCount,
  });
};
