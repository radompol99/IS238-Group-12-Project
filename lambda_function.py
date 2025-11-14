import os
import boto3
import json
import email
import requests

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")
table = ddb.Table(os.environ["ADDRESSES_TABLE"])

OPENROUTER_API_KEY = os.environ["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"]
TELEGRAM_BOT_TOKEN = os.environ["8587106666:AAEouKtLyfwDDp1hBtOaXi_Yp_PAfpE5Wzo"]
TELEGRAM_CHAT_ID = os.environ["is238"]

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
OPENAI_ENDPOINT = "https://openai.is238.upou.io/v1/chat/completions"


def summarize_with_openai(text):
    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "Summarize this email for a human."},
            {"role": "user", "content": text}
        ]
    }

    res = requests.post(
        OPENAI_ENDPOINT,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY}"
        },
        json=payload,
        timeout=30
    )

    res.raise_for_status()
    data = res.json()
    return data["choices"][0]["message"]["content"]


def lambda_handler(event, context):
    record = event["Records"][0]
    bucket = record["s3"]["bucket"]["name"]
    key = record["s3"]["object"]["key"]

    # Download email
    obj = s3.get_object(Bucket=bucket, Key=key)
    raw_email = obj["Body"].read().decode("utf-8")
    parsed = email.message_from_string(raw_email)

    sender = parsed.get("From", "")
    subject = parsed.get("Subject", "")
    address = parsed.get("To", "")

    # Extract text body
    body = ""
    if parsed.is_multipart():
        for part in parsed.walk():
            if part.get_content_type() == "text/plain":
                body = part.get_payload(decode=True).decode(errors="ignore")
                break
    else:
        body = parsed.get_payload(decode=True).decode(errors="ignore")

    # Check if address is active
    res = table.get_item(Key={"address": address}).get("Item")
    if not res or not res.get("active", True):
        print("Address disabled; skipping")
        return

    # Summarize via your OpenAI endpoint
    summary = summarize_with_openai(body[:15000])

    # Pre-signed URL (7 days)
    url = s3.generate_presigned_url(
        ClientMethod="get_object",
        ExpiresIn=604800,
        Params={"Bucket": bucket, "Key": key}
    )

    # Telegram message
    payload = {
        "chat_id": CHAT_ID,
        "text": (
            f"📥 *New email received*\n\n"
            f"*From:* {sender}\n"
            f"*Subject:* {subject}\n\n"
            f"*Summary:*\n{summary}"
        ),
        "parse_mode": "Markdown",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": "⬇️ Download raw email", "url": url}],
                [{"text": "🛑 Deactivate this address", "callback_data": f"deactivate:{address}"}]
            ]
        }
    }

    requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
        json=payload
    )

    return {"status": "ok"}
