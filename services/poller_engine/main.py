import time
import schedule
import logging
import requests
import subprocess
import os
import json
import re
import pika
import psycopg2
from psycopg2.extras import execute_values
import asyncio
from pysnmp.hlapi.asyncio import *

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("PollerEngine")

DEVICE_MANAGER_URL = os.getenv("DEVICE_MANAGER_URL", "http://device-manager:8000/devices/") # Deprecated, direct DB
DB_HOST = os.getenv("DB_HOST", "postgres")
DB_USER = os.getenv("POSTGRES_USER", "admin")
DB_PASS = os.getenv("POSTGRES_PASSWORD", "admin123")
DB_NAME = os.getenv("POSTGRES_DB", "nms_db")
RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_USER = os.getenv("RABBITMQ_USER", "admin")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "admin123")

# Connection caching
pg_conn = None
mq_conn = None
mq_channel = None

def get_pg_conn():
    global pg_conn
    if pg_conn and not pg_conn.closed:
        return pg_conn
    try:
        # TSDB connects to timescaledb on port 5432 internally
        pg_conn = psycopg2.connect(
            host="timescaledb",
            port="5432", 
            user=os.getenv("TSDB_USER", "metrics_user"),
            password=os.getenv("TSDB_PASSWORD", "metrics_pass"),
            dbname=os.getenv("TSDB_NAME", "nms_metrics")
        )
        pg_conn.autocommit = True
        with pg_conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS device_metrics (
                    time TIMESTAMPTZ NOT NULL,
                    device_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    latency_ms DOUBLE PRECISION
                );
            """)
            cur.execute("""
                SELECT create_hypertable('device_metrics', 'time', if_not_exists => TRUE);
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS cpu_mem_metrics (
                    time TIMESTAMPTZ NOT NULL,
                    device_id TEXT NOT NULL,
                    cpu_usage_percent DOUBLE PRECISION,
                    mem_usage_mb DOUBLE PRECISION
                );
            """)
            cur.execute("""
                SELECT create_hypertable('cpu_mem_metrics', 'time', if_not_exists => TRUE);
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS interface_metrics (
                    time TIMESTAMPTZ NOT NULL,
                    device_id TEXT NOT NULL,
                    interface_name TEXT NOT NULL,
                    interface_alias TEXT,
                    rx_bytes BIGINT,
                    tx_bytes BIGINT
                );
            """)
            cur.execute("""
                SELECT create_hypertable('interface_metrics', 'time', if_not_exists => TRUE);
            """)
            try:
                cur.execute("ALTER TABLE interface_metrics ADD COLUMN IF NOT EXISTS interface_alias TEXT;")
            except Exception:
                pass
        logger.info("Connected and synced schema (Phase 18) to TimescaleDB.")
    except Exception as e:
        logger.error(f"Postgres connection failed: {e}")
        pg_conn = None
    return pg_conn

def get_mq_channel():
    global mq_conn, mq_channel
    if mq_channel and mq_channel.is_open:
        return mq_channel
    try:
        credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
        parameters = pika.ConnectionParameters(RABBITMQ_HOST, credentials=credentials)
        mq_conn = pika.BlockingConnection(parameters)
        mq_channel = mq_conn.channel()
        mq_channel.queue_declare(queue="alerts", durable=True)
        logger.info("Connected to RabbitMQ for Alerts.")
    except Exception as e:
        logger.error(f"RabbitMQ connection failed: {e}")
        mq_channel = None
    return mq_channel

def do_ping(ip):
    try:
        # Linux ping command: 1 packet, 1 second timeout
        output = subprocess.check_output(f"ping -c 1 -W 1 {ip}", shell=True, text=True, stderr=subprocess.STDOUT)
        match = re.search(r'time=([0-9.]+) ms', output)
        if match:
            return "UP", float(match.group(1))
        return "UP", 0.0
    except subprocess.CalledProcessError:
        return "DOWN", -1.0

def get_devices():
    devices = []
    try:
        conn = psycopg2.connect(host=DB_HOST, port="5432", user=DB_USER, password=DB_PASS, dbname=DB_NAME)
        with conn.cursor() as cur:
            cur.execute("SELECT id, hostname, ip_address, type, vendor, snmp_community, snmp_port, sensor_filters, thresholds FROM devices")
            for r in cur.fetchall():
                devices.append({
                    "id": r[0], "hostname": r[1], "ip_address": r[2], "type": r[3], "vendor": r[4], 
                    "snmp_community": r[5] or "public", "snmp_port": r[6] or 161, 
                    "sensor_filters": r[7] or {},
                    "thresholds": r[8] or {}
                })
        conn.close()
    except Exception as e:
        logger.error(f"Cannot fetch devices from postgres: {e}")
    return devices

async def poll_device_snmp(device):
    # Retrieve base credentials
    ip = str(device.get('ip_address', '')).strip()
    port = device.get('snmp_port', 161)
    # Strip any trailing whitespace or \r\n from CSV imports
    community = str(device.get('snmp_community', 'public')).strip()
    engine = SnmpEngine()
    # Switch completely to bulletproof OS native snmpwalk binary
    import asyncio
    
    async def fetch_walk(oid_str):
        res = {}
        try:
            # SNMPv2c is standard for modern routers. Fast and reliable.
            proc = await asyncio.create_subprocess_exec(
                'snmpwalk', '-v2c', '-c', community, ip, oid_str, '-t', '4', '-r', '1', '-O', 'nq',
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            if proc.returncode != 0:
                # Fallback to SNMPv1 if v2c is rejected
                proc_v1 = await asyncio.create_subprocess_exec(
                    'snmpwalk', '-v1', '-c', community, ip, oid_str, '-t', '4', '-r', '1', '-O', 'nq',
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, stderr = await asyncio.wait_for(proc_v1.communicate(), timeout=30)
            
            lines = stdout.decode('utf-8', errors='ignore').splitlines()
            for line in lines:
                if not line.strip() or 'Timeout:' in line or 'No Such' in line or 'No Response' in line: continue
                # Example OS format: .1.3.6.1.2.1.2.2.1.2.10 "ether10" (because of -O nq)
                parts = line.split(maxsplit=1)
                if len(parts) == 2:
                    oid_full = parts[0]
                    # Snip trailing index
                    idx_str = oid_full.split('.')[-1]
                    val = parts[1].strip('"')
                    if idx_str.isdigit():
                        res[idx_str] = val
        except Exception as e:
            logger.error(f"fetch_walk ERROR on {ip} for {oid_str}: {repr(e)}")
        return res

    if_names = await fetch_walk('1.3.6.1.2.1.2.2.1.2')
    if_aliases = await fetch_walk('1.3.6.1.2.1.31.1.1.1.18')
    if_in = await fetch_walk('1.3.6.1.2.1.2.2.1.10')
    if_out = await fetch_walk('1.3.6.1.2.1.2.2.1.16')
    cpu_loads = await fetch_walk('1.3.6.1.2.1.25.3.3.1.2')
    
    def safe_int(val):
        try:
            return int(val)
        except:
            return 0
            
    sensor_filters = device.get('sensor_filters', {})
            
    interfaces = []
    for idx, name in if_names.items():
        is_monitored = sensor_filters.get(name, True)
        if not is_monitored:
            continue
            
        in_b = safe_int(if_in.get(idx, 0))
        out_b = safe_int(if_out.get(idx, 0))
        
        # ZERO-TRAFFIC PRUNING (AKTIF KEMBALI):
        if in_b == 0 and out_b == 0:
            continue
            
        interfaces.append({
            "name": name,
            "alias": if_aliases.get(idx, ""),
            "in_bytes": in_b,
            "out_bytes": out_b
        })
            
    avg_cpu = 0.0
    if cpu_loads:
        avg_cpu = sum(int(c) for c in cpu_loads.values() if str(c).isdigit()) / len(cpu_loads)

    thresholds = device.get('thresholds', {})
    max_cpu = thresholds.get('cpu', 80)
    
    if avg_cpu > max_cpu:
        mq = get_mq_channel()
        if mq:
            alert_msg = {
                "level": "CRITICAL",
                "title": "CPU Overload 🌡️",
                "message": f"Beban CPU router {device.get('hostname', 'Unknown')} melonjak ke {avg_cpu:.1f}% (Melewati Max Threshold {max_cpu}%)!"
            }
            try:
                mq.basic_publish(exchange='', routing_key='alerts', body=json.dumps(alert_msg), properties=pika.BasicProperties(delivery_mode=2))
            except Exception as e:
                logger.error(f"Gagal mengirim CPU alert ke RabbitMQ: {e}")

    try:
        from lldp_walker import walk_lldp_neighbors
        lldp_neighbors = await walk_lldp_neighbors(ip, community, port)
    except Exception as e:
        logger.error(f"Gagal mengambil LLDP {ip}: {e}")
        lldp_neighbors = []

    return device['id'], avg_cpu, 0.0, interfaces, lldp_neighbors

async def poll_all_snmp(devices):
    return await asyncio.gather(*(poll_device_snmp(d) for d in devices))

def poll_devices():
    logger.info("Starting polling cycle...")
    try:
        devices = get_devices()
        if not devices:
            logger.info("No devices found in inventory to poll.")
            return

        metrics_batch = []
        mq = get_mq_channel()

        for device in devices:
            status, latency = do_ping(device['ip_address'])
            logger.info(f"Polled {device['hostname']} ({device['ip_address']}): Status={status}, Latency={latency}ms")
            
            metrics_batch.append((device['id'], status, latency if latency >= 0 else None))

            thresholds = device.get('thresholds', {})
            max_ping = thresholds.get('ping', 150)

            if status == "DOWN" and mq:
                alert_msg = {
                    "level": "CRITICAL",
                    "title": "Device Down 💀",
                    "message": f"Sensor ping dari Poller gagal mencapai {device['hostname']} ({device['ip_address']}). Node Tumbang!"
                }
                try:
                    mq.basic_publish(exchange='', routing_key='alerts', body=json.dumps(alert_msg), properties=pika.BasicProperties(delivery_mode=2))
                except Exception as e:
                    pass
            elif status == "UP" and mq and latency > max_ping:
                alert_msg = {
                    "level": "WARNING",
                    "title": "High Ping Latency 🏓",
                    "message": f"Latensi {device['hostname']} ({device['ip_address']}) meroket tajam ke {latency}ms (Threshold Kustom: {max_ping}ms)!"
                }
                try:
                    mq.basic_publish(exchange='', routing_key='alerts', body=json.dumps(alert_msg), properties=pika.BasicProperties(delivery_mode=2))
                except Exception as e:
                    pass

        db = get_pg_conn()
        if db:
            try:
                with db.cursor() as cur:
                    if metrics_batch:
                        execute_values(
                            cur,
                            "INSERT INTO device_metrics (time, device_id, status, latency_ms) VALUES %s",
                            [(psycopg2.extensions.AsIs('NOW()'), m[0], m[1], m[2]) for m in metrics_batch]
                        )
                    
                    # SNMP Bulk Polling
                    snmp_results = asyncio.run(poll_all_snmp(devices))
                    cpu_batch = []
                    if_batch = []
                    lldp_batch = []
                    
                    for r in snmp_results:
                        did, cpu, mem, ifs, nbs = r
                        cpu_batch.append((psycopg2.extensions.AsIs('NOW()'), did, cpu, mem))
                        for interface in ifs:
                            if_batch.append((psycopg2.extensions.AsIs('NOW()'), did, interface['name'], interface['alias'], interface['in_bytes'], interface['out_bytes']))
                        
                        # Menyimpan LLDP Matches
                        for nb in nbs:
                            for dev in devices:
                                if dev['hostname'].lower() == nb['remote_host'].lower():
                                    lldp_batch.append((did, dev['id'], nb['local_port_id'], nb['remote_port'], 'auto'))
                                    break
                            
                    if cpu_batch:
                        execute_values(
                            cur,
                            "INSERT INTO cpu_mem_metrics (time, device_id, cpu_usage_percent, mem_usage_mb) VALUES %s",
                            cpu_batch
                        )
                    if if_batch:
                        execute_values(
                            cur,
                            "INSERT INTO interface_metrics (time, device_id, interface_name, interface_alias, rx_bytes, tx_bytes) VALUES %s",
                            if_batch
                        )
            except Exception as db_err:
                logger.error(f"Failed to bulk write metrics to TSDB: {db_err}")

        # Update Topology Links di Postgres (nms_db)
        if lldp_batch:
            try:
                conn_pg = psycopg2.connect(host=DB_HOST, port="5432", user=DB_USER, password=DB_PASS, dbname=DB_NAME)
                with conn_pg.cursor() as cur_pg:
                    execute_values(
                        cur_pg,
                        "INSERT INTO device_links (source_id, target_id, source_interface, target_interface, link_type) VALUES %s ON CONFLICT (source_id, target_id) DO UPDATE SET link_type = 'auto', source_interface = EXCLUDED.source_interface, target_interface = EXCLUDED.target_interface",
                        lldp_batch
                    )
                conn_pg.commit()
                conn_pg.close()
                logger.info(f"Berhasil merajut {len(lldp_batch)} garis auto-discovery topologi (LLDP)!")
            except Exception as lldp_err:
                logger.error(f"Gagal memutakhirkan LLDP target Topologi: {lldp_err}")

        logger.info("Selesai memproses iterasi ping perangkat.")
    except Exception as e:
        logger.error(f"Error during polling execution: {e}")

if __name__ == "__main__":
    logger.info("Poller Engine Started. Waiting for connections...")
    time.sleep(10) # Wait for infrastructure dependencies to boot up fully
    
    get_pg_conn()
    get_mq_channel()

    schedule.every(30).seconds.do(poll_devices)
    poll_devices() # Initial poll

    while True:
        schedule.run_pending()
        time.sleep(1)
