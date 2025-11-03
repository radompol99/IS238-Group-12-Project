'use strict';

import { ImapFlow } from 'imapflow';
import { google } from 'googleapis';
import { getSecretJson, buildS3Key, putRawEmailS3 } from '../shared/utils';

const BUCKET = process.env.S3_BUCKET;
const SECRETS_ARN = process.env.SECRETS_ARN;
const GMAIL_USER = process.env.GMAIL_USER;

async function getAccessTokenFromRefresh(params: { clientId: string; clientSecret: string; refreshToken: string; }): Promise<string> {
  const { clientId, clientSecret, refreshToken } = params;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const tokenRes = await oauth2Client.getAccessToken();
  const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
  if (!token) throw new Error('Failed to obtain Gmail access token');
  return token;
}

export const handler = async (_event: any = {}) => {
  if (!process.env.ENABLE_FETCH || String(process.env.ENABLE_FETCH).toLowerCase() === 'false') {
    console.log('ENABLE_FETCH=false; running in dry-run mode. Scaffold ready.');
    return { ok: true, dryRun: true };
  }

  if (!BUCKET || !SECRETS_ARN || !GMAIL_USER) {
    throw new Error('Missing required env: S3_BUCKET, SECRETS_ARN, GMAIL_USER');
  }

  const secret = await getSecretJson(SECRETS_ARN);
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = secret;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Secrets missing Gmail OAuth fields: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN');
  }

  const accessToken = await getAccessTokenFromRefresh({
    clientId: GMAIL_CLIENT_ID,
    clientSecret: GMAIL_CLIENT_SECRET,
    refreshToken: GMAIL_REFRESH_TOKEN,
  });

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, accessToken },
  });

  await client.connect();
  let processed = 0;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseen = await client.search({ seen: false });
      if (!unseen || unseen.length === 0) {
        console.log('No unseen messages.');
        return { ok: true, processed: 0 };
      }
      for await (const msg of client.fetch(unseen, { source: true, envelope: true, internalDate: true })) {
        const messageId = (msg as any)?.envelope?.messageId;
        const key = buildS3Key(messageId, (msg as any).internalDate || new Date());
        await putRawEmailS3(BUCKET, key, (msg as any).source);
        await client.messageFlagsAdd((msg as any).uid, ['\\Seen']);
        processed += 1;
        console.log(`Stored ${key}`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return { ok: true, processed };
};

