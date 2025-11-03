'use strict';

const { randomUUID } = require('crypto');
const { s3, secrets, PutObjectCommand, GetSecretValueCommand } = require('./aws');

async function getSecretJson(secretId) {
  if (!secretId) throw new Error('SECRETS_ARN not set');
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const str = res.SecretString || '{}';
  return JSON.parse(str);
}

function buildS3Key(messageId, date = new Date()) {
  const safeId = String(messageId || randomUUID()).replace(/[<>]/g, '');
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `emails/${y}/${m}/${d}/${safeId}.eml`;
}

async function putRawEmailS3(bucket, key, body) {
  if (!bucket) throw new Error('S3_BUCKET not set');
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  return { bucket, key };
}

module.exports = {
  getSecretJson,
  buildS3Key,
  putRawEmailS3,
};

