import socketserver
import psycopg2
import os
import logging
import re
import time

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("SyslogReceiver")

DB_HOST = os.getenv("DB_HOST", "timescaledb")
DB_USER = os.getenv("DB_USER", "metrics_user")
DB_PASS = os.getenv("DB_PASS", "metrics_pass")
DB_NAME = os.getenv("DB_NAME", "nms_metrics")

def init_db():
    retries = 5
    while retries > 0:
        try:
            conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
            with conn.cursor() as cur:
                cur.execute("""
                CREATE TABLE IF NOT EXISTS syslog_events (
                    id SERIAL PRIMARY KEY,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    source_ip VARCHAR(50) NOT NULL,
                    facility INT,
                    severity INT,
                    message TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_syslog_time ON syslog_events(timestamp DESC);
                """)
            conn.commit()
            conn.close()
            logger.info("✅ Database nms_metrics/syslog_events initialized.")
            return
        except Exception as e:
            logger.warning(f"DB init failed, retrying... ({retries} left). Error: {e}")
            retries -= 1
            time.sleep(3)
    logger.error("❌ DB init ultimately failed.")

class SyslogUDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        data = bytes.decode(self.request[0].strip(), errors='ignore')
        client_address = self.client_address[0]
        
        facility = 1  # user-level messages
        severity = 5  # notice
        message = data
        
        # Parse <PRI> prefix if standard syslog format
        m = re.match(r'<(\d+)>(.*)', data)
        if m:
            pri = int(m.group(1))
            facility = pri >> 3
            severity = pri & 7
            message = m.group(2).strip()
            
        try:
            conn = psycopg2.connect(host=DB_HOST, user=DB_USER, password=DB_PASS, dbname=DB_NAME)
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO syslog_events (source_ip, facility, severity, message) VALUES (%s, %s, %s, %s)",
                    (client_address, facility, severity, message)
                )
            conn.commit()
            conn.close()
            logger.info(f"📥 Diterima Syslog dari {client_address}: [F:{facility}/S:{severity}] {message[:70]}...")
        except Exception as e:
            logger.error(f"❌ DB Error: {e}")

if __name__ == "__main__":
    init_db()
    
    HOST, PORT = "0.0.0.0", 514
    server = socketserver.UDPServer((HOST, PORT), SyslogUDPHandler)
    logger.info(f"🎧 Modul Syslog & Trap Receiver mendengar pasif di {HOST}:{PORT}/UDP...")
    server.serve_forever()
