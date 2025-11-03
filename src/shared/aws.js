'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

const s3 = new S3Client({ region });
const secrets = new SecretsManagerClient({ region });
const ddb = new DynamoDBClient({ region });

module.exports = {
  s3,
  secrets,
  ddb,
  PutObjectCommand,
  GetSecretValueCommand,
};

