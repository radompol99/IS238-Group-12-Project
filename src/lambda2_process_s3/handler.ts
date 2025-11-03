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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY as string;
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL as string) || 'openrouter/auto';

async function getS3ObjectBody(bucket: string, key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Uint8Array[] = [];
  // @ts-ignore
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function summarize(text: string): Promise<string> {
  // Try primary OpenAI-like endpoint first (custom proxy or service)
  if (OPENAI_SUMMARY_URL && OPENAI_API_KEY) {
    try {
      const resp = await fetch(OPENAI_SUMMARY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ text }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        const val = data.summary || data.result || data.output || '';
        if (val) return String(val);
      } else {
        const body = await resp.text().catch(() => '');
        console.warn('Primary summary failed:', resp.status, body);
      }
    } catch (e) {
      console.warn('Primary summary exception:', (e as Error).message);
    }
  }

  // Fallback: OpenRouter chat completions
  if (OPENROUTER_API_KEY) {
    try {
      const url = 'https://openrouter.ai/api/v1/chat/completions';
      const prompt = `Summarize the following email for a non-technical reader in 5-8 concise bullet points. Include sender (if available), subject gist, key asks or decisions, dates/deadlines, and any attachment mentions. Keep it short and actionable.\n\n---\n${text.slice(0, 16000)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'X-Title': 'IS238 Email Summarizer',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            { role: 'system', content: 'You are a helpful assistant that writes concise business email summaries.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
        }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        const content = data?.choices?.[0]?.message?.content;
        if (content) return String(content);
        console.warn('OpenRouter returned no content');
      } else {
        const body = await resp.text().catch(() => '');
        console.warn('OpenRouter failed:', resp.status, body);
      }
    } catch (e) {
      console.warn('OpenRouter exception:', (e as Error).message);
    }
  }

  return 'Summary unavailable.';
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
