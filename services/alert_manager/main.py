import pika
import time
import logging
import json
import os
import requests

# Konfigurasi logger standar
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("AlertManager")

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_USER = os.getenv("RABBITMQ_USER", "admin")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "admin123")
QUEUE_NAME = "alerts"

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "YOUR_TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "YOUR_TELEGRAM_CHAT_ID")

def send_telegram_message(message):
    if TELEGRAM_BOT_TOKEN == "YOUR_TELEGRAM_BOT_TOKEN" or not TELEGRAM_BOT_TOKEN:
        logger.warning("Telegram Bot Token is not configured. Skipping external notification.")
        return
        
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML"
    }
    try:
        r = requests.post(url, json=payload, timeout=5)
        if r.status_code == 200:
            logger.info("Notifikasi berhasil diteruskan ke Grup Telegram.")
        else:
            logger.error(f"Gagal mengirim ke Telegram. Status: {r.status_code}, Response: {r.text}")
    except Exception as e:
        logger.error(f"Error mengirim ke Telegram API: {e}")

def callback(ch, method, properties, body):
    try:
        alert_data = json.loads(body)
        level = alert_data.get('level', 'INFO')
        title = alert_data.get('title', 'Unknown')
        msg = alert_data.get('message', '')
        
        logger.warning(f"🚨 SIAGA: [{level}] {title} - {msg}")
        
        # Konstruksi Pesan Telegram
        emoji = "🔴" if level == "CRITICAL" else ("⚠️" if level == "WARNING" else "ℹ️")
        tg_message = f"<b>{emoji} NMS ALERT {emoji}</b>\n\n<b>Level:</b> {level}\n<b>Title:</b> {title}\n<b>Message:</b> {msg}\n\n<i>Nexus NMS Automated Alert</i>"
        
        # Kirim ke Telegram API
        send_telegram_message(tg_message)
        
    except Exception as e:
        logger.error(f"Error memproses data alert: {e}")

def main():
    logger.info("Alert Manager dimulai. Berusaha terhubung ke Message Broker RabbitMQ...")
    credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
    parameters = pika.ConnectionParameters(RABBITMQ_HOST,
                                           credentials=credentials,
                                           heartbeat=60)
    
    connection = None
    for _ in range(15): # Mekanisme tunggu hingga RabbitMQ boot sempurna
        try:
            connection = pika.BlockingConnection(parameters)
            logger.info("Koneksi RabbitMQ stabil.")
            break
        except pika.exceptions.AMQPConnectionError:
            logger.info("RabbitMQ belum siap. Mencoba lagi dalam 5 detik...")
            time.sleep(5)
            
    if not connection:
        logger.error("Gagal terhubung secara persisten ke RabbitMQ. Keluar.")
        return

    channel = connection.channel()
    
    # Deklarasi antrean durable (bertahan walau rabbitmq restart)
    channel.queue_declare(queue=QUEUE_NAME, durable=True)

    channel.basic_consume(queue=QUEUE_NAME, on_message_callback=callback, auto_ack=True)

    logger.info(' [*] Menunggu event alerts di antrean (%s). Tekan CTRL+C untuk keluar', QUEUE_NAME)
    try:
        channel.start_consuming()
    except KeyboardInterrupt:
        logger.info("Mematikan consuming gracefully...")
        channel.stop_consuming()
    finally:
        connection.close()

if __name__ == '__main__':
    main()
