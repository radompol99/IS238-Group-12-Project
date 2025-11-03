'use strict';

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient, QueryCommand, PutItemCommand, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
import { Hash } from '@aws-sdk/hash-node';
import { formatUrl } from '@aws-sdk/util-format-url';

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

export const s3 = new S3Client({ region });
export const secrets = new SecretsManagerClient({ region });
export const ddb = new DynamoDBClient({ region });
export const presigner = new S3RequestPresigner({ ...s3.config, sha256: Hash.bind(null, 'sha256') as any });

export {
  PutObjectCommand,
  GetObjectCommand,
  GetSecretValueCommand,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
  formatUrl,
};

