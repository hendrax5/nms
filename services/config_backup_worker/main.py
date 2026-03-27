import time
import schedule
import logging
import os
import datetime
import pika
import json
import hashlib
import threading
import re
from contextlib import asynccontextmanager
from netmiko import ConnectHandler
import psycopg2

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("ConfigBackupWorker")

DB_HOST = os.getenv("DB_HOST", "postgres")
DB_USER = os.getenv("DB_USER", "admin")
DB_PASS = os.getenv("DB_PASS", "admin123")
DB_NAME = os.getenv("DB_NAME", "nms_db")
BACKUP_DIR = "/app/backups"

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_USER = os.getenv("RABBITMQ_USER", "admin")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "admin123")

os.makedirs(BACKUP_DIR, exist_ok=True)

def get_devices():
    devices = []
    try:
        conn = psycopg2.connect(host=DB_HOST, port="5432", user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        with conn.cursor() as cur:
            cur.execute("SELECT id, hostname, ip_address, vendor, ssh_user, ssh_pass, ssh_port, ssh_protocol FROM devices WHERE ssh_user IS NOT NULL AND ssh_user != ''")
            for r in cur.fetchall():
                devices.append({
                    "id": r[0], "hostname": r[1], "ip_address": r[2], "vendor": r[3],
                    "ssh_user": r[4], "ssh_pass": r[5], "ssh_port": r[6], "ssh_protocol": r[7]
                })
        conn.close()
    except Exception as e:
        logger.error(f"Cannot fetch devices from DB: {e}")
    return devices

def map_vendor_to_netmiko(vendor_name):
    v = vendor_name.lower() if vendor_name else "generic"
    if "cisco" in v: return "cisco_ios"
    if "juniper" in v: return "juniper_junos"
    if "mikrotik" in v: return "mikrotik_routeros"
    if "fortinet" in v: return "fortinet"
    if "palo alto" in v: return "paloalto_panos"
    if "aruba" in v: return "aruba_os"
    if "huawei" in v: return "huawei"
    if "zte" in v: return "zte_zxros"
    if "h3c" in v: return "hp_comware"
    if "ruijie" in v: return "ruijie_os"
    if "vyos" in v: return "vyos"
    if "danos" in v: return "vyos" # DANOS shares vyatta/vyos CLI
    if "linux" in v: return "linux"
    return "terminal_server"

def get_backup_command(device_type):
    dt = device_type.replace('_telnet', '')
    if dt == "cisco_ios": return "show running-config"
    if dt == "juniper_junos": return "show configuration | display set"
    if dt == "mikrotik_routeros": return "export"
    if dt == "fortinet": return "show full-configuration"
    if dt == "huawei": return "display current-configuration"
    if dt == "zte_zxros": return "show running-config"
    if dt == "hp_comware": return "display current-configuration"
    if dt == "ruijie_os": return "show running-config"
    if dt == "vyos": return "show configuration commands"
    if dt == "linux": return "cat /etc/os-release"
    return "show running-config"

def backup_single_device(dev):
    logger.info(f"Mencoba injeksi {'Telnet' if dev.get('ssh_protocol', '').lower() == 'telnet' else 'SSH'} ke {dev['hostname']} ({dev['ip_address']}:{dev['ssh_port']})...")
    netmiko_type = map_vendor_to_netmiko(dev['vendor'])
    if dev.get('ssh_protocol', '').lower() == 'telnet' and not netmiko_type.endswith('_telnet'):
        netmiko_type += '_telnet'
        
    connect_dict = {
        "device_type": netmiko_type,
        "host": dev['ip_address'],
        "username": dev['ssh_user'],
        "password": dev['ssh_pass'],
        "port": dev['ssh_port'],
        "global_delay_factor": 2,
    }
    
    try:
        with ConnectHandler(**connect_dict) as net_connect:
            cmd = get_backup_command(netmiko_type)
            output = net_connect.send_command(cmd, read_timeout=60)
            
            # Khusus Mikrotik: Bersihkan header ekspor dinamis pencipta duplikasi
            if "mikrotik" in netmiko_type:
                output = re.sub(r'(?m)^#\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\sby\sRouterOS.*$\n?', '', output)
                output = re.sub(r'(?m)^#\ssoftware\sid\s=.*$\n?', '', output)
                output = re.sub(r'(?m)^#\smodel\s=.*$\n?', '', output)
                output = re.sub(r'(?m)^#\sserial\snumber\s=.*$\n?', '', output)

            # Save to Database device_configs table
            version_hash = hashlib.sha256(output.encode('utf-8')).hexdigest()
            
            conn = psycopg2.connect(host=DB_HOST, port="5432", user=DB_USER, password=DB_PASS, dbname=DB_NAME)
            with conn.cursor() as cur:
                # Check previous config to avoid redundant inserts if completely identical
                cur.execute("SELECT version_hash FROM device_configs WHERE device_id = %s ORDER BY created_at DESC LIMIT 1", (dev['id'],))
                last_hash = cur.fetchone()
                
                if not last_hash or last_hash[0] != version_hash:
                    cur.execute(
                        "INSERT INTO device_configs (device_id, config_text, version_hash) VALUES (%s, %s, %s)",
                        (dev['id'], output, version_hash)
                    )
                    conn.commit()
                    logger.info(f"✅ Konfigurasi tersimpan sebagai Versi Baru ke DB (Hash: {version_hash[:8]})")
                else:
                    logger.info(f"⚡ Konfigurasi IDENTIK dengan versi sebelumnya. Diabaikan (Hash: {version_hash[:8]})")
            conn.close()

            # Save to File System Legacy
            today_str = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M")
            dev_dir = os.path.join(BACKUP_DIR, dev['hostname'])
            os.makedirs(dev_dir, exist_ok=True)
            filename = os.path.join(dev_dir, f"{today_str}_{version_hash[:8]}.txt")
            with open(filename, "w", encoding='utf-8') as f:
                f.write(output)
                
    except Exception as e:
        logger.error(f"❌ Backup GAGAL untuk node {dev['hostname']}: Operasi SSH terputus / Timeout. rincian: {e}")

def backup_all_devices():
    logger.info("Mengeksekusi siklus Rutin Backup Konfigurasi...")
    devices = get_devices()
    if not devices:
        logger.info("Tidak ada perangkat valid kredensial SSH untuk di-backup. Skip operasi.")
        return
    for dev in devices:
        backup_single_device(dev)

def restore_single_device(dev, config_id):
    logger.info(f"🔄 Inisiasi Live Restore pada {dev['hostname']} ({dev['ip_address']})...")
    conn = psycopg2.connect(host=DB_HOST, port="5432", user=DB_USER, password=DB_PASS, dbname=DB_NAME)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT config_text FROM device_configs WHERE id = %s AND device_id = %s", (config_id, dev['id']))
            res = cur.fetchone()
            if not res:
                logger.error(f"❌ Config ID {config_id} tidak valid untuk device {dev['hostname']}!")
                return
            config_text = res[0]
            
        netmiko_type = map_vendor_to_netmiko(dev['vendor'])
        if dev.get('ssh_protocol', '').lower() == 'telnet' and not netmiko_type.endswith('_telnet'):
            netmiko_type += '_telnet'
            
        connect_dict = {
            "device_type": netmiko_type,
            "host": dev['ip_address'],
            "username": dev['ssh_user'],
            "password": dev['ssh_pass'],
            "port": dev['ssh_port'],
            "global_delay_factor": 2,
        }
        
        with ConnectHandler(**connect_dict) as net_connect:
            logger.info("Connected! Menerapkan 'send_config_set'...")
            # Pisahkan baris karena send_config_set butuh iterator/list
            config_lines = config_text.split('\n')
            
            # Khusus untuk linux (demo) kita tak bisa kirim config_set
            if netmiko_type == "linux":
                logger.warning("OS Linux tidak menerima native config_set via SSH untuk NMS Demo. Diabaikan.")
                return
                
            output = net_connect.send_config_set(config_lines)
            net_connect.save_config()
            logger.info(f"✅ Restore Konfigurasi Berhasil Diterapkan ke NVRAM/Startup!\nSebagian Log:\n{output[:200]}...")
            
        # Pancing backup otomatis paska restore
        backup_single_device(dev)
        
    except Exception as e:
        logger.error(f"❌ GAGAL Live Restore ke {dev['hostname']}: {e}")
    finally:
        conn.close()

def mq_callback(ch, method, properties, body):
    try:
        msg = json.loads(body)
        action = msg.get("action")
        device_id = msg.get("device_id")
        
        devices = get_devices()
        target_dev = next((d for d in devices if d["id"] == device_id), None)
        
        if not target_dev:
            logger.error(f"❌ Device {device_id} tidak siap SSH atau tak ada di database!")
            return
            
        if action == "trigger_backup":
            logger.info(f"📥 Instruksi MANUAL BACKUP untuk: {device_id}")
            backup_single_device(target_dev)
            
        elif action == "restore_backup":
            config_id = msg.get("config_id")
            logger.info(f"📥 Instruksi MANUAL RESTORE untuk: {device_id} (Config #{config_id})")
            restore_single_device(target_dev, config_id)
            
    except Exception as e:
        logger.error(f"Gagal memproses pesan MQ: {e}")
    finally:
        ch.basic_ack(delivery_tag=method.delivery_tag)

def start_rabbitmq_listener():
    while True:
        try:
            credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
            connection = pika.BlockingConnection(pika.ConnectionParameters(host=RABBITMQ_HOST, credentials=credentials))
            channel = connection.channel()
            channel.queue_declare(queue='config_backup_tasks', durable=True)
            channel.basic_qos(prefetch_count=1)
            channel.basic_consume(queue='config_backup_tasks', on_message_callback=mq_callback)
            logger.info("🐰 Worker terhubung ke RabbitMQ. Menunggu perintah Backup manual...")
            channel.start_consuming()
        except pika.exceptions.AMQPConnectionError:
            logger.warning("Koneksi RabbitMQ terputus. Mencoba ulang dalam 5 detik...")
            time.sleep(5)
        except Exception as e:
            logger.error(f"Error RabbitMQ Listener: {e}")
            time.sleep(5)

if __name__ == "__main__":
    logger.info("Service Config Backup Worker Started. Siap mengamankan ruang mesin Anda.")
    time.sleep(10)
    
    # Start RabbitMQ Listener Thread
    threading.Thread(target=start_rabbitmq_listener, daemon=True).start()
    
    # Jalankan run perdana saat kontainer hidup
    backup_all_devices()
    
    # Jadwalkan berjalan otomatis
    schedule.every(5).minutes.do(backup_all_devices)
    
    while True:
        schedule.run_pending()
        time.sleep(10)
