import os
import boto3
import requests
import email

s3 = boto3.client('s3')

# Environment variables
OPENROUTER_API_KEY = os.environ["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"]
TELEGRAM_BOT_TOKEN = os.environ["8587106666:AAEouKtLyfwDDp1hBtOaXi_Yp_PAfpE5Wzo"]
TELEGRAM_CHAT_ID = os.environ["is238"]

OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "gpt-4o-mini")

def summarize_email(subject, body):
    """Send email content to OpenRouter for summarization."""
    prompt = f"Summarize this email in a concise paragraph:\n\nSubject: {subject}\n\n{body}"

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://your-app.example.com/",
        "X-Title": "Email Summarizer Lambda"
    }

    data = {
        "model": OPENROUTER_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 300,
    }

    resp = requests.post("https://openrouter.ai/api/v1/chat/completions", json=data, headers=headers)
    resp.raise_for_status()
    summary = resp.json()["choices"][0]["message"]["content"]
    return summary.strip()


def send_to_telegram(message):
    """Send a message to Telegram chat."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "Markdown"
    }
    requests.post(url, json=payload)


def parse_email_file(file_path):
    """Parse .eml file and extract subject and text body."""
    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        raw_email = f.read()

    msg = email.message_from_string(raw_email)
    subject = msg.get('Subject', '(no subject)')
    sender = msg.get('From', '')

    body = ''
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == 'text/plain':
                body += part.get_payload(decode=True).decode(errors='ignore')
    else:
        body = msg.get_payload(decode=True).decode(errors='ignore')

    return subject, sender, body.strip()


def lambda_handler(event, context):
    # Get S3 info
    record = event['Records'][0]
    bucket = record['s3']['bucket']['name']
    key = record['s3']['object']['key']

    tmp_path = f"/tmp/{os.path.basename(key)}"
    s3.download_file(bucket, key, tmp_path)

    # Parse email
    subject, sender, body = parse_email_file(tmp_path)

    # Summarize via OpenRouter
    summary = summarize_email(subject, body)

    # Send summary to Telegram
    telegram_msg = f"📧 *Email Summary*\nFrom: {sender}\nSubject: {subject}\n\n{summary}"
    send_to_telegram(telegram_msg)

    return {"statusCode": 200, "body": "Summary sent to Telegram"}
