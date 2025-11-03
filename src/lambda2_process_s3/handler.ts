'use strict';

import { simpleParser } from 'mailparser';
import fetch from 'node-fetch';
import { s3, ddb, presigner, GetObjectCommand, QueryCommand, formatUrl } from '../shared/aws';
import { buildS3Key } from '../shared/utils';

const TABLE = process.env.DDB_TABLE as string;
const BUCKET = process.env.S3_BUCKET as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const OPENAI_SUMMARY_URL = process.env.OPENAI_SUMMARY_URL as string;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY as string;

async function getS3ObjectBody(bucket: string, key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Uint8Array[] = [];
  // @ts-ignore
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function summarize(text: string): Promise<string> {
  if (!OPENAI_SUMMARY_URL || !OPENAI_API_KEY) return 'Summary service not configured.';
  const resp = await fetch(OPENAI_SUMMARY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Summary failed: ${resp.status} ${body}`);
  }
  const data = (await resp.json()) as any;
  return data.summary || data.result || 'No summary produced.';
}

async function presignDownload(bucket: string, key: string, days = 7): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const url = await presigner.presign(command, { expiresIn: days * 24 * 60 * 60 });
  return typeof url === 'string' ? url : formatUrl(url);
}

async function findUserByAddress(address: string): Promise<{ userId: string; chatId: number } | null> {
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :gpk',
    ExpressionAttributeValues: {
      ':gpk': { S: `ADDRESS#${address.toLowerCase()}` },
    },
    Limit: 1,
  }));
  const item = q.Items?.[0];
  if (!item) return null;
  const userId = item.GSI1SK?.S?.replace('USER#', '') || '';
  const chatId = Number(item.chatId?.N || '0');
  return userId && chatId ? { userId, chatId } : null;
}

async function sendTelegram(chatId: number, text: string, buttons?: any) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    parse_mode: 'HTML',
    reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.error('Telegram error', resp.status, t);
  }
}

export const handler = async (event: any) => {
  // S3 Put event
  const record = event?.Records?.[0];
  if (!record) return { ok: true, reason: 'no-records' };
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  const raw = await getS3ObjectBody(bucket, key);
  const parsed = await simpleParser(raw);
  const subject = parsed.subject || '(no subject)';
  const plain = parsed.text || '';
  const html = parsed.html ? String(parsed.html) : '';
  const bodyForSummary = plain || html.replace(/<[^>]+>/g, ' ');

  // naive: take first addressed recipient
  const toAddr = (parsed.to?.value?.[0]?.address || '').toLowerCase();
  const user = await findUserByAddress(toAddr);

  const summary = await summarize(bodyForSummary);
  const downloadUrl = await presignDownload(bucket, key, 7);

  if (user) {
    const text = `📧 <b>${escapeHtml(subject)}</b>\n\n${escapeHtml(summary)}\n\n➡️ <a href="${downloadUrl}">Download raw email</a>`;
    const buttons = [
      [
        { text: 'Download raw email', url: downloadUrl },
        { text: 'Deactivate this address', callback_data: `deactivate:${toAddr}` },
      ],
    ];
    await sendTelegram(user.chatId, text, buttons);
  } else {
    console.log('No user mapping found for address', toAddr);
  }

  return { ok: true };
};

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

