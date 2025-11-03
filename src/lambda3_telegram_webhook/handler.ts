'use strict';

import fetch from 'node-fetch';
import { randomBytes } from 'crypto';
import { ddb, PutItemCommand, UpdateItemCommand, QueryCommand } from '../shared/aws';

const TABLE = process.env.DDB_TABLE as string;
const DOMAIN = process.env.DOMAIN as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET as string;

export const handler = async (event: any) => {
  if (WEBHOOK_SECRET && event?.headers) {
    const hdr = event.headers['x-telegram-bot-api-secret-token'] || event.headers['X-Telegram-Bot-Api-Secret-Token'];
    if (hdr !== WEBHOOK_SECRET) return { statusCode: 401, body: 'unauthorized' };
  }

  const update = parseBody(event.body);
  // handle callback
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const data: string = cq.data || '';
    if (data.startsWith('deactivate:')) {
      const addr = data.split(':')[1];
      await deactivateAddress(chatId, addr);
      await sendTelegram(chatId, `Deactivated ${addr}`);
    }
    return ok();
  }

  const msg = update.message;
  if (!msg || !msg.text) return ok();
  const chatId = msg.chat.id;
  const text: string = String(msg.text).trim();

  if (text === '/start') {
    await ensureUser(chatId, msg.from);
    await sendTelegram(chatId, 'Welcome! Use /help to see available commands.');
  } else if (text === '/help') {
    const helpText = `
<b>Available Commands:</b>

/start - Welcome message
/help - Show this help message
/new - Generate a new email address
/list - View all your active email addresses
/deactivate &lt;address&gt; - Deactivate an email address

<b>Example:</b>
/deactivate abc123@${DOMAIN}
    `.trim();
    await sendTelegram(chatId, helpText);
  } else if (text === '/new') {
    const addr = await createAddress(chatId);
    await sendTelegram(chatId, `New address: <b>${addr}</b>\nSend email to this address to receive summaries here.`);
  } else if (text === '/list') {
    const list = await listAddresses(chatId);
    if (!list.length) await sendTelegram(chatId, 'No active addresses. Use /new to create one.');
    else await sendTelegram(chatId, list.map(a => `• ${a}`).join('\n'));
  } else if (text.startsWith('/deactivate')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegram(chatId, 'Usage: /deactivate <email-address>\nExample: /deactivate abc123@upou2025manny.ninja');
    } else {
      const addr = parts[1].trim();
      await deactivateAddress(chatId, addr);
      await sendTelegram(chatId, `✓ Deactivated ${addr}`);
    }
  } else {
    await sendTelegram(chatId, 'Unknown command. Try /help to see available commands.');
  }

  return ok();
};

function ok() { return { statusCode: 200, body: 'ok' }; }

function parseBody(body: any) {
  if (!body) return {} as any;
  try { return typeof body === 'string' ? JSON.parse(body) : body; } catch { return {}; }
}

async function ensureUser(chatId: number, from: any) {
  const pk = `USER#${chatId}`;
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: pk },
      sk: { S: 'PROFILE' },
      chatId: { N: String(chatId) },
      firstName: { S: String(from?.first_name || '') },
      username: { S: String(from?.username || '') },
    },
  }));
}

function randAddress(): string {
  const id = randomBytes(3).toString('hex');
  return `${id}@${DOMAIN}`;
}

async function createAddress(chatId: number): Promise<string> {
  const addr = randAddress();
  const pk = `USER#${chatId}`;
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: pk },
        sk: { S: `ADDRESS#${addr}` },
        GSI1PK: { S: `ADDRESS#${addr.toLowerCase()}` },
        GSI1SK: { S: `USER#${chatId}` },
        status: { S: 'ACTIVE' },
        chatId: { N: String(chatId) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (e) {
    // If user profile doesn't exist yet, create it and retry
    await ensureUser(chatId, {});
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: pk },
        sk: { S: `ADDRESS#${addr}` },
        GSI1PK: { S: `ADDRESS#${addr.toLowerCase()}` },
        GSI1SK: { S: `USER#${chatId}` },
        status: { S: 'ACTIVE' },
        chatId: { N: String(chatId) },
      },
    }));
  }
  return addr;
}

async function listAddresses(chatId: number): Promise<string[]> {
  const pk = `USER#${chatId}`;
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: {
      ':pk': { S: pk },
      ':sk': { S: 'ADDRESS#' },
    },
  }));
  return (q.Items || [])
    .filter(i => i.status?.S === 'ACTIVE')
    .map(i => (i.sk?.S || '').replace('ADDRESS#', ''));
}

async function deactivateAddress(chatId: number, addr: string) {
  const pk = `USER#${chatId}`;
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: { S: pk }, sk: { S: `ADDRESS#${addr}` } },
    UpdateExpression: 'SET #s = :inactive',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':inactive': { S: 'INACTIVE' } },
  }));
}

async function sendTelegram(chatId: number, text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch((e) => console.error('Telegram error', e));
}

