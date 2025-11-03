# 📬 Telegram Email Summarizer MVP (Serverless Scaffold)

A **serverless MVP** that lets Telegram users receive **summaries of incoming emails**.  
Each user can generate random email addresses (under your company domain), and when emails are sent there, the bot summarizes them via OpenAI and delivers summaries through Telegram — with a download link for the raw email.

---

## 🚀 Features

- ✉️ **Cloudflare Email Routing** — forwards any `@yourcompany.com` email to a shared Gmail inbox.
- 📥 **Lambda #1 (Fetcher)** — fetches unread Gmail emails using IMAP OAuth, stores raw emails in S3.
- 🧠 **Lambda #2 (Processor)** — triggered by new S3 objects; parses the email, sends it to OpenAI for summarization, sends the summary to Telegram with:
  - “⬇️ Download raw email” (7-day S3 pre-signed URL)
  - “🛑 Deactivate this address” (two-step confirmation)
- 🤖 **Lambda #3 (Telegram Webhook)** — handles `/start`, `/new`, `/list`, and deactivation flow.
- 🗂️ **DynamoDB** — stores user info and generated email addresses.
- ☁️ **Fully Serverless** — no EC2, always on.
- 🕒 **Latency target:** ≤ 2 minutes from email receipt to Telegram summary.

---

## 🧩 Architecture Overview

```
Cloudflare Email Routing → Gmail Inbox
      ↓ (IMAP via OAuth)
 Lambda #1 — Fetch & store raw emails → S3 bucket
      ↓ (S3 event trigger)
 Lambda #2 — Parse → Summarize → Notify Telegram
      ↓ (API Gateway Webhook)
 Lambda #3 — Telegram Bot (register/deactivate)
      ↳ DynamoDB: users + addresses
```

---

## 🛠️ Tech Stack

| Component | Technology |
|------------|-------------|
| Runtime | Node.js 20 (TypeScript) |
| Infra-as-Code | Serverless Framework |
| Cloud | AWS Lambda, S3, DynamoDB, EventBridge, API Gateway, Secrets Manager |
| Email | Gmail IMAP (OAuth2) + Cloudflare Email Routing |
| Bot | Telegram Bot API |
| Summarization | Custom OpenAI endpoint |
| Package Manager | Yarn v1.22+ |

---

## ⚙️ Project Structure

```
telegram-email-summarizer/
├─ serverless.yml
├─ package.json
├─ yarn.lock
├─ src/
│  ├─ lambda1_fetch_gmail/handler.ts
│  ├─ lambda2_process_s3/handler.ts
│  ├─ lambda3_telegram_webhook/handler.ts
│  └─ shared/
│      ├─ ddb.ts
│      ├─ utils.ts
│      └─ types.ts
└─ README.md
```

---

## 🧰 Prerequisites

1. **Node.js 18+** (Node 20 recommended)  
   ```bash
   node -v
   ```
2. **Yarn v1.22+**  
   ```bash
   yarn -v
   ```
3. **AWS CLI configured**  
   ```bash
   aws configure
   ```
4. **Serverless Framework** (bundled via npx)
   ```bash
   npx serverless --version
   ```

---

## 🪄 Setup (Local Development)

### STEP 1 – Initialize Project
```bash
yarn init -y
yarn add -D serverless @types/node typescript esbuild
yarn add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/client-secrets-manager @aws-sdk/client-dynamodb node-fetch mailparser imapflow googleapis
npx tsc --init
```

### STEP 2 – Environment Variables
Create a `.env` or export variables before deploy:
```
DOMAIN=yourcompany.com
S3_BUCKET=email-raw-messages-dev
DDB_TABLE=EmailBotUsers
DDB_GSI1=GSI1
SECRETS_ARN=arn:aws:secretsmanager:REGION:ACCT:secret:gmail-oauth-secrets-ABC
GMAIL_USER=mvp-bot-inbox@gmail.com
TELEGRAM_BOT_TOKEN=123456:ABC...
WEBHOOK_SECRET=your-webhook-secret
OPENAI_SUMMARY_URL=https://your-openai-endpoint/summary
OPENAI_API_KEY=your-api-key

# Cloudflare Email Routing (for automatic email forwarding)
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
CLOUDFLARE_ZONE_ID=your-zone-id
```

### STEP 2.1 – Cloudflare Setup (Required)

**What is Cloudflare Email Routing?**
Cloudflare Email Routing allows you to automatically forward emails sent to your custom domain to your Gmail inbox without needing your own email server.

**Setup Steps:**

1. **Add your domain to Cloudflare**
   - Go to https://dash.cloudflare.com
   - Add your domain (e.g., `upou2025manny.ninja`)
   - Update your domain's nameservers to Cloudflare's nameservers

2. **Enable Email Routing**
   - In Cloudflare Dashboard, go to Email → Email Routing
   - Click "Get started" and follow the setup wizard
   - Add your Gmail address as a verified destination email
   - Verify the email address by clicking the link sent to your Gmail

3. **Get API Token**
   - Go to My Profile → API Tokens → Create Token
   - Use template "Edit Zone" or create custom token with this permission:
     - Zone → Email Routing Rules → Edit
   - Copy the API token to `CLOUDFLARE_API_TOKEN`

4. **Get Zone ID and Account ID**
   - Go to your domain's Overview page in Cloudflare
   - Scroll down to "API" section on the right sidebar
   - Copy **Zone ID** to `CLOUDFLARE_ZONE_ID`

**How it works:**
- When a user creates a new email address (`/new`), Lambda 3 automatically creates a Cloudflare Email Routing rule
- Emails sent to `abc123@yourdomain.com` → Forwarded to your Gmail inbox
- When deactivated (`/deactivate`), Lambda 3 deletes the routing rule
- Lambda 1 fetches from Gmail and processes the emails

### STEP 3 – AWS Secrets Manager (for Gmail)
Store your Gmail OAuth details securely:
```json
{
  "GMAIL_CLIENT_ID": "xxx.apps.googleusercontent.com",
  "GMAIL_CLIENT_SECRET": "xxx",
  "GMAIL_REFRESH_TOKEN": "xxx"
}
```

---

## ☁️ Deployment

Deploy all 3 Lambdas + infra in one command:

```bash
yarn deploy
```

This will create:
- S3 bucket (with lifecycle → Glacier after 30 days, expire 180 days)
- DynamoDB table (on-demand)
- EventBridge 1-minute cron for Gmail fetcher
- API Gateway endpoint for Telegram webhook

---

## 🤖 Telegram Webhook Setup

After deploy, note the **API Gateway URL** (e.g. `https://abc123.execute-api.ap-southeast-1.amazonaws.com/telegram/webhook`).

Set Telegram webhook:
```bash
curl -X POST   https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook   -H 'Content-Type: application/json'   -d '{"url":"https://abc123.execute-api.ap-southeast-1.amazonaws.com/telegram/webhook","secret_token":"my_webhook_secret"}'
```

---

## 🧠 Flow Validation Checklist

1. `/start` → bot welcomes user.  
2. `/new` → generates a random address like `8bq2ka@yourcompany.com`.  
3. Send email to that address.  
4. Gmail → Lambda #1 → S3 → Lambda #2 → Telegram summary arrives in ≤ 2 min.  
5. Buttons shown:  
   - “⬇️ Download raw email” → 7-day S3 pre-signed link  
   - “🛑 Deactivate this address” → confirmation → deactivate  
6. `/list` → lists all active addresses.

---

## 📁 DynamoDB Data Model

| pk | sk | GSI1PK | GSI1SK | status | Notes |
|----|----|--------|--------|--------|-------|
| USER#12345 | PROFILE | — | — | — | Telegram user profile |
| USER#12345 | ADDRESS#8bq2ka@yourcompany.com | ADDRESS#8bq2ka@yourcompany.com | USER#12345 | ACTIVE | Active email address |

---

## 🔐 IAM Permissions Summary

| Lambda | Permissions |
|---------|--------------|
| Fetcher #1 | secretsmanager:GetSecretValue, s3:PutObject |
| Processor #2 | s3:GetObject, dynamodb:Query |
| Webhook #3 | dynamodb:PutItem, UpdateItem, Query |
| All | logs:CreateLogGroup, CreateLogStream, PutLogEvents |

---

## 🧹 Lifecycle Policy Example

S3 bucket auto-management:
```json
{
  "Rules": [{
    "ID": "email-retention",
    "Status": "Enabled",
    "Transitions": [{ "Days": 30, "StorageClass": "GLACIER_IR" }],
    "Expiration": { "Days": 180 }
  }]
}
```

---

## 🪧 Development Tips

- Use `yarn build` before deployment.
- Test handlers locally:
  ```bash
  yarn serverless invoke local -f lambda1FetchGmail
  ```
- Check logs:
  ```bash
  npx serverless logs -f lambda2ProcessS3
  ```
- Use **CloudWatch Logs** for debugging.

---

## 📚 References

- [AWS Lambda Docs](https://docs.aws.amazon.com/lambda/)
- [Serverless Framework Docs](https://www.serverless.com/framework/docs/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Gmail IMAP OAuth Guide](https://developers.google.com/gmail/imap/xoauth2-protocol)
- [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)

---

## 🧾 License

MIT © 2025  GROUP 12  — for educational MVP use.
