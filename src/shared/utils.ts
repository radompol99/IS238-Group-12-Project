'use strict';

import { randomUUID } from 'crypto';
import { s3, secrets, PutObjectCommand, GetSecretValueCommand } from './aws';

export async function getSecretJson(secretId?: string): Promise<Record<string, string>> {
  if (!secretId) throw new Error('SECRETS_ARN not set');
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const str = res.SecretString || '{}';
  return JSON.parse(str);
}

export function buildS3Key(messageId?: string, date: Date = new Date()): string {
  const safeId = String(messageId || randomUUID()).replace(/[<>]/g, '');
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `emails/${y}/${m}/${d}/${safeId}.eml`;
}

export async function putRawEmailS3(bucket: string | undefined, key: string, body: any) {
  if (!bucket) throw new Error('S3_BUCKET not set');
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  return { bucket, key };
}

