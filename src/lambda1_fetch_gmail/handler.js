'use strict';

const { ImapFlow } = require('imapflow');
const { google } = require('googleapis');
const { getSecretJson, buildS3Key, putRawEmailS3 } = require('../shared/utils');

const BUCKET = process.env.S3_BUCKET;
const SECRETS_ARN = process.env.SECRETS_ARN;
const GMAIL_USER = process.env.GMAIL_USER;

async function getAccessTokenFromRefresh({ clientId, clientSecret, refreshToken }) {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error('Failed to obtain Gmail access token');
  return token;
}

exports.handler = async (event = {}) => {
  if (!process.env.ENABLE_FETCH || String(process.env.ENABLE_FETCH).toLowerCase() === 'false') {
    console.log('ENABLE_FETCH=false; running in dry-run mode. Scaffold ready.');
    return { ok: true, dryRun: true };
  }

  if (!BUCKET || !SECRETS_ARN || !GMAIL_USER) {
    throw new Error('Missing required env: S3_BUCKET, SECRETS_ARN, GMAIL_USER');
  }

  const secrets = await getSecretJson(SECRETS_ARN);
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = secrets;

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
        const messageId = msg?.envelope?.messageId;
        const key = buildS3Key(messageId, msg.internalDate || new Date());
        await putRawEmailS3(BUCKET, key, msg.source);
        await client.messageFlagsAdd(msg.uid, ['\\Seen']);
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

