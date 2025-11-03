'use strict';

import fetch from 'node-fetch';
import { randomBytes } from 'crypto';
import { ddb, PutItemCommand, UpdateItemCommand, QueryCommand } from '../shared/aws';

const TABLE = process.env.DDB_TABLE as string;
const DOMAIN = process.env.DOMAIN as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET as string;
const GMAIL_USER = process.env.GMAIL_USER as string;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN as string;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID as string;

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
      await sendTelegram(chatId, `✅ <b>Address deactivated</b>\n\n📧 <code>${addr}</code>\n\nThis address will no longer receive emails.`);
    }
    return ok();
  }

  const msg = update.message;
  if (!msg || !msg.text) return ok();
  const chatId = msg.chat.id;
  const text: string = String(msg.text).trim();

  if (text === '/start') {
    await ensureUser(chatId, msg.from);
    await sendTelegram(chatId, `👋 <b>Welcome to AI Email Summarizer!</b>

I help you create disposable email addresses to protect your privacy.

📧 Generated emails will be forwarded here as AI summaries.

Type /help to see what I can do!`);
  } else if (text === '/help') {
    const helpText = `
📋 <b>Available Commands:</b>

/start - Welcome message
/help - Show this help menu
/new - Create a new temporary email address
/list - View all your active email addresses
/deactivate &lt;address&gt; - Deactivate an email address

💡 <b>How it works:</b>
1. Use /new to generate an email address
2. Share it with websites or services
3. Receive AI-powered email summaries here
4. Deactivate when done

<b>Example:</b>
<code>/deactivate abc123@${DOMAIN}</code>
    `.trim();
    await sendTelegram(chatId, helpText);
  } else if (text === '/new') {
    const addr = await createAddress(chatId);
    await sendTelegram(chatId, `✅ <b>New email address created!</b>

📧 <code>${addr}</code>

Use this address to sign up for services. You'll receive AI summaries of any emails sent to it.

💡 Tip: Tap to copy the address above.`);
  } else if (text === '/list') {
    const list = await listAddresses(chatId);
    if (!list.length) {
      await sendTelegram(chatId, `📭 <b>No active addresses</b>

You don't have any active email addresses yet.

Use /new to create your first temporary email address!`);
    } else {
      const addresses = list.map((a, i) => `${i + 1}. <code>${a}</code>`).join('\n');
      await sendTelegram(chatId, `📬 <b>Your Active Email Addresses:</b>\n\n${addresses}\n\n💡 Use /deactivate to remove an address`);
    }
  } else if (text.startsWith('/deactivate')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegram(chatId, `❌ <b>Missing email address</b>

<b>Usage:</b> /deactivate &lt;address&gt;

<b>Example:</b>
<code>/deactivate abc123@${DOMAIN}</code>

💡 Use /list to see your active addresses`);
    } else {
      const addr = parts[1].trim();
      await deactivateAddress(chatId, addr);
      await sendTelegram(chatId, `✅ <b>Address deactivated</b>

📧 <code>${addr}</code>

This address will no longer receive emails.

Use /new to create a new address or /list to see your remaining addresses.`);
    }
  } else {
    await sendTelegram(chatId, `❓ <b>Unknown command</b>

I didn't understand that command.

Type /help to see all available commands.`);
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
  
  // Create Cloudflare email route
  const routeId = await createCloudflareEmailRoute(addr);
  
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
        ...(routeId && { cloudflareRouteId: { S: routeId } }),
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
        ...(routeId && { cloudflareRouteId: { S: routeId } }),
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
  
  // Get the address record to find the Cloudflare route ID
  const getResult = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk = :sk',
    ExpressionAttributeValues: {
      ':pk': { S: pk },
      ':sk': { S: `ADDRESS#${addr}` },
    },
  }));

  const addressRecord = getResult.Items?.[0];
  const routeId = addressRecord?.cloudflareRouteId?.S;

  // Delete Cloudflare route if it exists
  if (routeId) {
    await deleteCloudflareEmailRoute(routeId);
  }

  // Update DynamoDB status
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

// Cloudflare Email Routing API functions
async function createCloudflareEmailRoute(emailAddress: string): Promise<string | null> {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID || !GMAIL_USER) {
    console.warn('Cloudflare credentials not configured, skipping email route creation');
    return null;
  }

  const url = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/email/routing/rules`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        matchers: [
          {
            type: 'literal',
            field: 'to',
            value: emailAddress,
          },
        ],
        actions: [
          {
            type: 'forward',
            value: [GMAIL_USER],
          },
        ],
        enabled: true,
        name: `Route for ${emailAddress}`,
      }),
    });

    const data = await response.json() as any;
    
    if (!response.ok || !data.success) {
      console.error('Cloudflare API error:', data);
      return null;
    }

    return data.result?.tag || data.result?.id || null;
  } catch (error) {
    console.error('Failed to create Cloudflare email route:', error);
    return null;
  }
}

async function deleteCloudflareEmailRoute(routeId: string): Promise<boolean> {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID || !routeId) {
    return false;
  }

  const url = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/email/routing/rules/${routeId}`;
  
  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json() as any;
    return response.ok && data.success;
  } catch (error) {
    console.error('Failed to delete Cloudflare email route:', error);
    return false;
  }
}

