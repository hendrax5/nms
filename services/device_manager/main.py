from fastapi import FastAPI, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import logging
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import requests
import jwt
import pika
import json
import difflib
from contextlib import asynccontextmanager
from datetime import datetime
import asyncio
from netmiko import ConnectHandler, NetmikoTimeoutException, NetmikoAuthenticationException

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DB_HOST = os.getenv("DB_HOST", "postgres")
DB_USER = os.getenv("POSTGRES_USER", "admin")
DB_PASS = os.getenv("POSTGRES_PASSWORD", "admin123")
DB_NAME = os.getenv("POSTGRES_DB", "nms_db")

def get_db_connection():
    try:
        conn = psycopg2.connect(
            host=DB_HOST,
            port="5432",
            user=DB_USER,
            password=DB_PASS,
            dbname=DB_NAME
        )
        return conn
    except Exception as e:
        logger.error(f"Cannot connect to postgres: {e}")
        return None

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Create tables if not exist
    conn = get_db_connection()
    if conn:
        with conn.cursor() as cur:
            cur.execute('''
                CREATE TABLE IF NOT EXISTS devices (
                    id VARCHAR(255) PRIMARY KEY,
                    hostname VARCHAR(255) NOT NULL,
                    ip_address VARCHAR(255) NOT NULL UNIQUE,
                    type VARCHAR(100),
                    vendor VARCHAR(100),
                    snmp_community VARCHAR(255) DEFAULT 'public',
                    snmp_port INTEGER DEFAULT 161,
                    ssh_user VARCHAR(255),
                    ssh_pass VARCHAR(255),
                    ssh_port INTEGER DEFAULT 22,
                    ssh_protocol VARCHAR(50) DEFAULT 'ssh',
                    thresholds JSONB DEFAULT '{}'::jsonb,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            # Create Device Links for Topology
            cur.execute('''
                CREATE TABLE IF NOT EXISTS device_links (
                    id SERIAL PRIMARY KEY,
                    source_id VARCHAR(255) REFERENCES devices(id) ON DELETE CASCADE,
                    target_id VARCHAR(255) REFERENCES devices(id) ON DELETE CASCADE,
                    source_interface VARCHAR(100) DEFAULT '',
                    target_interface VARCHAR(100) DEFAULT '',
                    link_type VARCHAR(50) DEFAULT 'manual',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(source_id, target_id)
                )
            ''')
            try:
                cur.execute("ALTER TABLE device_links ADD COLUMN IF NOT EXISTS link_type VARCHAR(50) DEFAULT 'manual';")
            except Exception:
                conn.rollback()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS device_configs (
                    id SERIAL PRIMARY KEY,
                    device_id VARCHAR(255) NOT NULL,
                    config_text TEXT NOT NULL,
                    version_hash VARCHAR(64) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
                )
            """)
            conn.commit()
        conn.close()
        logger.info("Database PostgreSQL schema initialized.")
    else:
        logger.warning("Starting without DB connection!")
    yield
    # Shutdown
    pass

app = FastAPI(title="NMS Device Manager API", lifespan=lifespan)

# --- KEYCLOAK SSO ZERO-TRUST ---
security = HTTPBearer()
KEYCLOAK_URL = os.getenv("KEYCLOAK_URL", "http://keycloak:8080")
REALM = "nms_realm"
keycloak_pub_key = None

def get_public_key():
    try:
        r = requests.get(f"{KEYCLOAK_URL}/realms/{REALM}", timeout=5)
        if r.status_code == 200:
            return "-----BEGIN PUBLIC KEY-----\n" + r.json()['public_key'] + "\n-----END PUBLIC KEY-----"
    except Exception as e:
        logger.error(f"Cannot fetch Keycloak Public Key: {e}")
    return None

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    global keycloak_pub_key
    if not keycloak_pub_key:
        keycloak_pub_key = get_public_key()
    
    if not keycloak_pub_key:
        raise HTTPException(status_code=500, detail="Identity Provider Unreachable")

    token = credentials.credentials
    try:
        payload = jwt.decode(
            token, 
            keycloak_pub_key, 
            algorithms=["RS256"], 
            options={"verify_aud": False}
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token Expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid Token: {str(e)}")


class Device(BaseModel):
    id: str | None = None
    hostname: str
    ip_address: str
    type: str = "Router" # router, switch, server, firewall
    vendor: str = "Cisco" # cisco, juniper, mikrotik, dll
    snmp_community: str = "public"
    snmp_port: int = 161
    ssh_user: str | None = None
    ssh_pass: str | None = None
    ssh_port: int = 22
    ssh_protocol: str = "ssh"
    thresholds: dict = {}

class DeviceLink(BaseModel):
    id: int | None = None
    source_id: str
    target_id: str
    source_interface: str = ""
    target_interface: str = ""
    link_type: str = "manual"

class DeviceConfig(BaseModel):
    id: int
    device_id: str
    config_text: str
    version_hash: str
    created_at: datetime

class TracePathRequest(BaseModel):
    source_id: str
    target_id: str


@app.get("/health")
def health_check():
    return {"status": "UP", "database": "PostgreSQL"}

@app.post("/devices/", response_model=Device)
def create_device(device: Device, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM devices WHERE id = %s", (device.id,))
            if cur.fetchone():
                raise HTTPException(status_code=400, detail="Device ID already exists in PostgreSQL")
            
            cur.execute(
                "INSERT INTO devices (id, hostname, ip_address, type, vendor, snmp_community, snmp_port, ssh_user, ssh_pass, ssh_port, ssh_protocol, thresholds) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (device.id, device.hostname, device.ip_address, device.type, device.vendor, device.snmp_community, device.snmp_port, device.ssh_user, device.ssh_pass, device.ssh_port, device.ssh_protocol, json.dumps(device.thresholds))
            )
            conn.commit()
            logger.info(f"Device saved to Database: {device.hostname} ({device.ip_address})")
            return device
    except psycopg2.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

class TestDevice(BaseModel):
    ip_address: str
    vendor: str
    ssh_user: str | None = None
    ssh_pass: str | None = None
    ssh_port: int = 22
    ssh_protocol: str = "ssh"
    snmp_community: str = "public"
    snmp_port: int = 161

@app.post("/devices/test")
def test_device_connection(req: TestDevice, user: dict = Depends(get_current_user)):
    results = {"snmp": {"success": False, "message": ""}, "remote": {"success": False, "message": ""}}
    
    # Check SNMP
    try:
        from pysnmp.hlapi.asyncio import getCmd, SnmpEngine, CommunityData, UdpTransportTarget, ContextData, ObjectType, ObjectIdentity
        import asyncio
        
        async def run_snmp():
            return await getCmd(
                SnmpEngine(),
                CommunityData(req.snmp_community, mpModel=0),
                UdpTransportTarget((req.ip_address, req.snmp_port), timeout=2, retries=1),
                ContextData(),
                ObjectType(ObjectIdentity('1.3.6.1.2.1.1.1.0'))
            )
        
        errorIndication, errorStatus, errorIndex, varBinds = asyncio.run(run_snmp())
        
        if errorIndication:
            results["snmp"]["message"] = str(errorIndication)
        elif errorStatus:
            results["snmp"]["message"] = str(errorStatus)
        else:
            results["snmp"]["success"] = True
            results["snmp"]["message"] = f"OK! sysDescr: {str(varBinds[0][1])[:40]}"
    except ImportError as e:
         results["snmp"]["message"] = f"PySNMP Module Missing: {e}"
    except Exception as e:
        results["snmp"]["message"] = f"SNMP Error: {e}"

    # Check Remote (SSH/Telnet)
    try:
        from netmiko import ConnectHandler, NetmikoTimeoutException, NetmikoAuthenticationException
        
        v = req.vendor.lower()
        netmiko_type = "terminal_server"
        if "cisco" in v: netmiko_type = "cisco_ios"
        elif "juniper" in v: netmiko_type = "juniper_junos"
        elif "mikrotik" in v: netmiko_type = "mikrotik_routeros"
        elif "fortinet" in v: netmiko_type = "fortinet"
        elif "huawei" in v: netmiko_type = "huawei"
        elif "zte" in v: netmiko_type = "zte_zxros"
        elif "h3c" in v: netmiko_type = "hp_comware"
        elif "ruijie" in v: netmiko_type = "ruijie_os"
        elif "vyos" in v or "danos" in v: netmiko_type = "vyos"
        elif "linux" in v: netmiko_type = "linux"
        
        if req.ssh_protocol.lower() == 'telnet' and not netmiko_type.endswith('_telnet'):
            netmiko_type += '_telnet'
            
        auth_dict = {
            "device_type": netmiko_type,
            "host": req.ip_address,
            "username": req.ssh_user or "",
            "password": req.ssh_pass or "",
            "port": req.ssh_port,
            "auth_timeout": 5,
            "timeout": 5
        }
        
        with ConnectHandler(**auth_dict) as ch:
            prompt = ch.find_prompt()
            results["remote"]["success"] = True
            results["remote"]["message"] = f"Sukses Login! Prompt: {prompt}"
            
    except ImportError:
         results["remote"]["message"] = "Netmiko module is installing in background..."
    except Exception as e:
        msg = str(e).lower()
        if "timeout" in msg:
            results["remote"]["message"] = "Timeout! IP atau Port tertutup."
        elif "authentication" in msg or "login" in msg:
            results["remote"]["message"] = "Login Ditolak (User/Pass salah)."
        else:
            results["remote"]["message"] = f"Gagal: {e}"

    return results

def execute_traceroute(device_dict, target_ip):
    try:
        from netmiko import ConnectHandler
        import re
        
        v = str(device_dict.get('vendor') or "").lower()
        netmiko_type = "cisco_ios"
        if "mikrotik" in v: netmiko_type = "mikrotik_routeros"
        elif "juniper" in v: netmiko_type = "juniper_junos"
        elif "huawei" in v: netmiko_type = "huawei"
        
        protocol = str(device_dict.get('ssh_protocol') or 'ssh').lower()
        if protocol == 'telnet' and not netmiko_type.endswith('_telnet'):
            netmiko_type += '_telnet'
            
        auth_dict = {
            "device_type": netmiko_type,
            "host": device_dict['ip_address'],
            "username": device_dict['ssh_user'] or "",
            "password": device_dict['ssh_pass'] or "",
            "port": device_dict['ssh_port'] or 22,
            "timeout": 30,
            "global_delay_factor": 2
        }
        
        hops = []
        with ConnectHandler(**auth_dict) as ch:
            if "mikrotik" in netmiko_type:
                cmd = f"tool traceroute address={target_ip} use-dns=no duration=5s"
            elif "huawei" in netmiko_type:
                cmd = f"tracert {target_ip}"
            else:
                cmd = f"traceroute {target_ip} numeric"
                
            output = ch.send_command(cmd, read_timeout=45)
            ip_pattern = r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b'
            for line in output.split('\n'):
                if 'traceroute' in line.lower() or 'address' in line.lower() or 'loss' in line.lower(): continue
                match = re.search(ip_pattern, line)
                if match:
                    ip = match.group(0)
                    if not hops or hops[-1] != ip:
                        hops.append(ip)
        return {"hops": hops, "raw": output}
    except Exception as e:
        err_msg = str(e)
        logger.error(f"Traceroute failed on {device_dict['ip_address']}: {err_msg}")
        return {"hops": [], "raw": f"Netmiko Execution Error:\n{err_msg}"}

import asyncio

@app.post("/topology/trace-path")
async def trace_path(req: TracePathRequest, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="DB unavailable")
        
    all_devices = {}
    source_dev = None
    target_dev = None
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, hostname, ip_address, vendor, ssh_user, ssh_pass, ssh_port, ssh_protocol FROM devices")
            for r in cur.fetchall():
                d = {
                    "id": r[0], "hostname": r[1], "ip_address": r[2], "vendor": r[3],
                    "ssh_user": r[4], "ssh_pass": r[5], "ssh_port": r[6], "ssh_protocol": r[7]
                }
                all_devices[r[0]] = d
                all_devices[r[2]] = d
            source_dev = all_devices.get(req.source_id)
            target_dev = all_devices.get(req.target_id)
    finally:
        conn.close()

    if not source_dev or not target_dev:
        logger.error(f"Trace Failed. Source ID: '{req.source_id}' (Found: {bool(source_dev)}) | Target ID: '{req.target_id}' (Found: {bool(target_dev)})")
        logger.error(f"Available DB keys: {list(all_devices.keys())}")
        raise HTTPException(status_code=404, detail="Source or Target devices not found in inventory.")

    forward_task = asyncio.to_thread(execute_traceroute, source_dev, target_dev['ip_address'])
    reverse_task = asyncio.to_thread(execute_traceroute, target_dev, source_dev['ip_address'])
    
    forward_result, reverse_result = await asyncio.gather(forward_task, reverse_task)
    
    def map_hops(ips, my_dev):
        path = []
        for ip in ips:
            if ip in all_devices:
                path.append(all_devices[ip]['id'])
            else:
                path.append(ip)
        if path and path[0] == my_dev['id']: path.pop(0)
        return path
        
    fwd = map_hops(forward_result["hops"], source_dev)
    rev = map_hops(reverse_result["hops"], target_dev)
    
    fwd_cmp = list(fwd)
    if fwd_cmp and fwd_cmp[-1] == target_dev['id']: fwd_cmp.pop()
    
    rev_rev = list(reversed(rev))
    if rev_rev and rev_rev[0] == source_dev['id']: rev_rev.pop(0)
    
    is_symmetric = (fwd_cmp == rev_rev)
    
    return {
        "status": "success",
        "forward": fwd,
        "reverse": rev,
        "forward_raw": forward_result["raw"],
        "reverse_raw": reverse_result["raw"],
        "is_symmetric": is_symmetric
    }

@app.get("/links/", response_model=list[DeviceLink])
def get_links(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, source_id, target_id, source_interface, target_interface, link_type FROM device_links")
            links = [{"id": r[0], "source_id": r[1], "target_id": r[2], "source_interface": r[3], "target_interface": r[4], "link_type": r[5]} for r in cur.fetchall()]
            return links
    finally:
        conn.close()

@app.post("/links/", response_model=DeviceLink)
def create_link(link: DeviceLink, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO device_links (source_id, target_id, source_interface, target_interface, link_type) VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (link.source_id, link.target_id, link.source_interface, link.target_interface, link.link_type)
            )
            created_id = cur.fetchone()[0]
            conn.commit()
            link.id = created_id
            return link
    except psycopg2.IntegrityError:
        conn.rollback()
        raise HTTPException(status_code=400, detail="Link already exists or invalid devices.")
    finally:
        conn.close()

@app.delete("/links/{link_id}")
def delete_link(link_id: int, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
         raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM device_links WHERE id = %s RETURNING id", (link_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Link not found")
            conn.commit()
            return {"message": "Link deleted"}
    finally:
        conn.close()

@app.get("/devices/")
def get_devices(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, hostname, ip_address, type, vendor, snmp_community, ssh_user, ssh_pass, ssh_port, snmp_port, ssh_protocol, thresholds FROM devices")
            rows = cur.fetchall()
            devices = [
                {
                    "id": r[0], "hostname": r[1], "ip_address": r[2], "type": r[3], "vendor": r[4], 
                    "snmp_community": r[5] if len(r)>5 else "public",
                    "ssh_user": r[6] if len(r)>6 else "",
                    "ssh_pass": r[7] if len(r)>7 else "",
                    "ssh_port": r[8] if len(r)>8 and r[8] is not None else 22,
                    "snmp_port": r[9] if len(r)>9 and r[9] is not None else 161,
                    "ssh_protocol": r[10] if len(r)>10 and r[10] is not None else "ssh",
                    "thresholds": r[11] if len(r)>11 and r[11] is not None else {}
                }
                for r in rows
            ]
            return devices
    finally:
        conn.close()

@app.put("/devices/{device_id}", response_model=Device)
def update_device(device_id: str, device: Device, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM devices WHERE id = %s", (device_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Device not found")
            
            cur.execute(
                "UPDATE devices SET hostname=%s, ip_address=%s, type=%s, vendor=%s, snmp_community=%s, snmp_port=%s, ssh_user=%s, ssh_pass=%s, ssh_port=%s, ssh_protocol=%s, thresholds=%s WHERE id=%s",
                (device.hostname, device.ip_address, device.type, device.vendor, device.snmp_community, device.snmp_port, device.ssh_user, device.ssh_pass, device.ssh_port, device.ssh_protocol, json.dumps(device.thresholds), device_id)
            )
            conn.commit()
            logger.info(f"Device updated: {device.hostname}")
            return device
    except psycopg2.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/devices/{device_id}", response_model=Device)
def get_device(device_id: str, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, hostname, ip_address, type, vendor, snmp_community, ssh_user, ssh_pass, ssh_port, snmp_port, ssh_protocol, thresholds FROM devices WHERE id = %s", (device_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Device not found")
            return {
                "id": row[0], "hostname": row[1], "ip_address": row[2], "type": row[3], "vendor": row[4], 
                "snmp_community": row[5] if len(row)>5 else "public",
                "ssh_user": row[6] if len(row)>6 else "",
                "ssh_pass": row[7] if len(row)>7 else "",
                "ssh_port": row[8] if len(row)>8 and row[8] is not None else 22,
                "snmp_port": row[9] if len(row)>9 and row[9] is not None else 161,
                "ssh_protocol": row[10] if len(row)>10 and row[10] is not None else "ssh",
                "thresholds": row[11] if len(row)>11 and row[11] is not None else {}
            }
    finally:
        conn.close()

@app.delete("/devices/{device_id}")
def delete_device(device_id: str, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM devices WHERE id = %s", (device_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Device not found")
            
            cur.execute("DELETE FROM devices WHERE id = %s", (device_id,))
            conn.commit()
            logger.info(f"Device DELETED from Database: {device_id}")
            return {"message": "Device deleted from Database successfully"}
    except psycopg2.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

# --- NCM (Network Configuration Management) ENDPOINTS ---

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_USER = os.getenv("RABBITMQ_USER", "admin")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "admin123")

@app.post("/devices/{device_id}/backups/trigger")
def trigger_manual_backup(device_id: str, user: dict = Depends(get_current_user)):
    """Mengirim sinyal via RabbitMQ agar worker segera mem-backup perangkat spesifik"""
    try:
        credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
        connection = pika.BlockingConnection(pika.ConnectionParameters(host=RABBITMQ_HOST, credentials=credentials))
        channel = connection.channel()
        channel.queue_declare(queue='config_backup_tasks', durable=True)
        
        msg = json.dumps({"action": "trigger_backup", "device_id": device_id})
        channel.basic_publish(
            exchange='',
            routing_key='config_backup_tasks',
            body=msg,
            properties=pika.BasicProperties(delivery_mode=2) # make message persistent
        )
        connection.close()
        return {"message": f"Manual backup triggered for {device_id}"}
    except Exception as e:
        logger.error(f"Cannot publish to RabbitMQ: {e}")
        raise HTTPException(status_code=500, detail="Failed to connect to Message Broker")

@app.get("/devices/{device_id}/backups")
def get_device_backups(device_id: str, user: dict = Depends(get_current_user)):
    """Mengembalikan riwayat versi konfigurasi dari database"""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, device_id, config_text, version_hash, created_at FROM device_configs WHERE device_id = %s ORDER BY created_at DESC", (device_id,))
            rows = cur.fetchall()
            return [
                {
                    "id": r[0],
                    "device_id": r[1],
                    "config_text": r[2],
                    "version_hash": r[3],
                    "created_at": r[4]
                }
                for r in rows
            ]
    finally:
        conn.close()

class CompareRequest(BaseModel):
    config_id_1: int
    config_id_2: int

@app.post("/devices/backups/compare")
def compare_backups(req: CompareRequest, user: dict = Depends(get_current_user)):
    """Membandingkan dua konfigurasi masa lalu"""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
    
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT config_text, created_at FROM device_configs WHERE id = %s", (req.config_id_1,))
            res1 = cur.fetchone()
            cur.execute("SELECT config_text, created_at FROM device_configs WHERE id = %s", (req.config_id_2,))
            res2 = cur.fetchone()
            
            if not res1 or not res2:
                raise HTTPException(status_code=404, detail="One or both config IDs not found")
                
            text1 = res1[0].splitlines(keepends=True)
            text2 = res2[0].splitlines(keepends=True)
            
            # Unified diff output
            diff = list(difflib.unified_diff(
                text1, 
                text2, 
                fromfile=f"Version 1 ({res1[1].strftime('%Y-%m-%d %H:%M')})", 
                tofile=f"Version 2 ({res2[1].strftime('%Y-%m-%d %H:%M')})"
            ))
            
            return {
                "diff_text": "".join(diff),
                "is_identical": len(diff) == 0
            }
    finally:
        conn.close()

class RestoreRequest(BaseModel):
    config_id: int

@app.post("/devices/{device_id}/backups/restore")
def restore_backup(device_id: str, req: RestoreRequest, user: dict = Depends(get_current_user)):
    """Mengirim perintah ke RabbitMQ agar worker me-restore konfigurasi lama ke perangkat"""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
        
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM device_configs WHERE id = %s AND device_id = %s", (req.config_id, device_id))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Config ID does not belong to this device or not found")
                
        # Kirim MQ Restore
        credentials = pika.PlainCredentials(RABBITMQ_USER, RABBITMQ_PASSWORD)
        connection = pika.BlockingConnection(pika.ConnectionParameters(host=RABBITMQ_HOST, credentials=credentials))
        channel = connection.channel()
        channel.queue_declare(queue='config_backup_tasks', durable=True)
        
        msg = json.dumps({"action": "restore_backup", "device_id": device_id, "config_id": req.config_id})
        channel.basic_publish(
            exchange='',
            routing_key='config_backup_tasks',
            body=msg,
            properties=pika.BasicProperties(delivery_mode=2)
        )
        connection.close()
        return {"message": f"Restore task queued for device {device_id} with config #{req.config_id}"}
    except pika.exceptions.AMQPError as e:
        logger.error(f"Cannot publish restore to MQ: {e}")
        raise HTTPException(status_code=500, detail="Failed to queue restore operation")
    finally:
        conn.close()

class ComplianceRequest(BaseModel):
    device_id: str
    required_strings: list[str]

@app.post("/devices/compliance")
def check_compliance(req: ComplianceRequest, user: dict = Depends(get_current_user)):
    """Memeriksa apakah konfigurasi terbaru perangkat mengandung string wajib (Baseline)"""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
        
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT config_text, created_at FROM device_configs WHERE device_id = %s ORDER BY created_at DESC LIMIT 1", (req.device_id,))
            res = cur.fetchone()
            if not res:
                raise HTTPException(status_code=404, detail="No configuration backup found for this device")
                
            config_text = res[0]
            missing_strings = []
            
            for req_str in req.required_strings:
                if req_str not in config_text:
                    missing_strings.append(req_str)
            
            return {
                "device_id": req.device_id,
                "latest_backup_time": res[1].isoformat(),
                "is_compliant": len(missing_strings) == 0,
                "missing_rules": missing_strings
            }
    finally:
        conn.close()

@app.get("/devices/{device_id}/interfaces")
def get_device_interfaces(device_id: str, user: dict = Depends(get_current_user)):
    """Mengambil daftar antarmuka aktif dari TimescaleDB dan status pantau dari Postgres."""
    import os
    
    sensor_filters = {}
    conn_pg = get_db_connection()
    if conn_pg:
        try:
            with conn_pg.cursor() as cur:
                cur.execute("SELECT sensor_filters FROM devices WHERE id = %s", (device_id,))
                res = cur.fetchone()
                if res and res[0]:
                    sensor_filters = res[0]
        except Exception as e:
            logger.error(f"Error fetching sensor_filters: {e}")
        finally:
            conn_pg.close()

    try:
        conn_metrics = psycopg2.connect(
            host=os.getenv("TIMESCALEDB_HOST", "timescaledb"),
            database=os.getenv("TIMESCALEDB_DB", "nms_metrics"),
            user=os.getenv("TIMESCALEDB_USER", "metrics_user"),
            password=os.getenv("TIMESCALEDB_PASSWORD", "metrics_pass"),
            port=int(os.getenv("TIMESCALEDB_PORT", 5432))
        )
        with conn_metrics.cursor() as cur:
            cur.execute(
                "SELECT interface_name, MAX(interface_alias) FROM interface_metrics WHERE device_id = %s GROUP BY interface_name ORDER BY interface_name",
                (device_id,)
            )
            rows = cur.fetchall()
            
            result = []
            for r in rows:
                iface_name = r[0]
                is_mon = sensor_filters.get(iface_name, True)
                result.append({
                    "name": iface_name,
                    "alias": r[1] or "",
                    "is_monitored": is_mon
                })
            return result
    except psycopg2.Error as e:
        logger.error(f"Error fetching interfaces from metrics DB: {e}")
        return []
    finally:
        if 'conn_metrics' in locals() and conn_metrics:
            conn_metrics.close()


class SensorUpdateRequest(BaseModel):
    interface_name: str
    is_monitored: bool

@app.post("/devices/{device_id}/sensors")
def update_sensor_filter(device_id: str, req: SensorUpdateRequest, user: dict = Depends(get_current_user)):
    """Memperbarui status whitelist (monitoring) antarmuka/sensor ke PostgreSQL (JSONB)"""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection failed")
        
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT sensor_filters FROM devices WHERE id = %s", (device_id,))
            res = cur.fetchone()
            if not res:
                raise HTTPException(status_code=404, detail="Device not found")
                
            current_filters = res[0] or {}
            current_filters[req.interface_name] = req.is_monitored
            
            import json
            cur.execute("UPDATE devices SET sensor_filters = %s WHERE id = %s", (json.dumps(current_filters), device_id))
            conn.commit()
            
        return {"status": "success", "interface": req.interface_name, "is_monitored": req.is_monitored}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.get("/devices/dashboard/top-metrics")
def get_top_metrics(user: dict = Depends(get_current_user)):
    """Mengambil Top 5 CPU & Top 5 Latency dari TimescaleDB untuk Global Dashboard."""
    import os
    try:
        conn_metrics = psycopg2.connect(
            host=os.getenv("TIMESCALEDB_HOST", "timescaledb"),
            database=os.getenv("TIMESCALEDB_DB", "nms_metrics"),
            user=os.getenv("TIMESCALEDB_USER", "metrics_user"),
            password=os.getenv("TIMESCALEDB_PASSWORD", "metrics_pass"),
            port=int(os.getenv("TIMESCALEDB_PORT", 5432))
        )
        
        with conn_metrics.cursor() as cur:
            # Top 5 CPU
            cur.execute("""
                SELECT device_id, last(cpu_usage_percent, time) as latest_cpu 
                FROM cpu_mem_metrics 
                WHERE time > NOW() - INTERVAL '5 minutes' 
                GROUP BY device_id 
                ORDER BY latest_cpu DESC NULLS LAST LIMIT 5;
            """)
            top_cpu = [{"device_id": r[0], "value": float(r[1]) if r[1] else 0.0} for r in cur.fetchall()]

            # Top 5 Latency
            cur.execute("""
                SELECT device_id, last(latency_ms, time) as latest_lat 
                FROM device_metrics 
                WHERE time > NOW() - INTERVAL '5 minutes' AND status = 'UP' AND latency_ms IS NOT NULL
                GROUP BY device_id 
                ORDER BY latest_lat DESC NULLS LAST LIMIT 5;
            """)
            top_latency = [{"device_id": r[0], "value": float(r[1]) if r[1] else 0.0} for r in cur.fetchall()]

        return {"top_cpu": top_cpu, "top_latency": top_latency}
    except psycopg2.Error as e:
        logger.error(f"Error fetching top metrics from DB: {e}")
        return {"top_cpu": [], "top_latency": []}
    finally:
        if 'conn_metrics' in locals() and conn_metrics:
            conn_metrics.close()

@app.get("/devices/topology/live-metrics")
def get_topology_live_metrics(user: dict = Depends(get_current_user)):
    """Menarik last known bytes_in_rate & bytes_out_rate dari TimescaleDB untuk Topology Map."""
    import os
    try:
        conn_metrics = psycopg2.connect(
            host=os.getenv("TIMESCALEDB_HOST", "timescaledb"),
            database=os.getenv("TIMESCALEDB_DB", "nms_metrics"),
            user=os.getenv("TIMESCALEDB_USER", "metrics_user"),
            password=os.getenv("TIMESCALEDB_PASSWORD", "metrics_pass"),
            port=int(os.getenv("TIMESCALEDB_PORT", 5432))
        )
        with conn_metrics.cursor() as cur:
            cur.execute("""
                SELECT device_id, interface_name, 
                       last(bytes_in_rate, time) as in_rate, 
                       last(bytes_out_rate, time) as out_rate 
                FROM interface_metrics 
                WHERE time > NOW() - INTERVAL '5 minutes'
                GROUP BY device_id, interface_name;
            """)
            result = {}
            for r in cur.fetchall():
                key = f"{r[0]}__{r[1]}"
                result[key] = {
                    "in_rate": float(r[2]) if r[2] else 0.0,
                    "out_rate": float(r[3]) if r[3] else 0.0
                }
        return {"status": "success", "data": result}
    except psycopg2.Error as e:
        logger.error(f"Error fetching topology metrics: {e}")
        return {"status": "error", "data": {}}
    finally:
        if 'conn_metrics' in locals() and conn_metrics:
            conn_metrics.close()

@app.get("/reports/executive")
def get_executive_report(period: str = "30 days", user: dict = Depends(get_current_user)):
    """Menghasilkan tabulasi SLA dan Rata-rata Pemakaian setiap perangkat untuk fungsi Laporan Eksport."""
    import os
    conn_db = get_db_connection()
    if not conn_db:
        raise HTTPException(status_code=500, detail="Database connection failed")
        
    devices = {}
    try:
        with conn_db.cursor() as cur:
            cur.execute("SELECT id, hostname, ip_address, status, type FROM devices")
            for r in cur.fetchall():
                devices[r[0]] = {"id": r[0], "name": r[1], "ip": r[2], "current_status": r[3], "type": r[4], "avg_cpu": 0.0, "avg_ping": 0.0, "sla_percent": 100.0}
    finally:
        conn_db.close()
        
    try:
        conn_ts = psycopg2.connect(
            host=os.getenv("TIMESCALEDB_HOST", "timescaledb"),
            database=os.getenv("TIMESCALEDB_DB", "nms_metrics"),
            user=os.getenv("TIMESCALEDB_USER", "metrics_user"),
            password=os.getenv("TIMESCALEDB_PASSWORD", "metrics_pass"),
            port=int(os.getenv("TIMESCALEDB_PORT", 5432))
        )
        with conn_ts.cursor() as cur:
            # Rata-rata CPU
            cur.execute(f"SELECT device_id, AVG(cpu_usage_percent) FROM cpu_mem_metrics WHERE time > NOW() - INTERVAL '{period}' GROUP BY device_id")
            for r in cur.fetchall():
                if r[0] in devices and r[1] is not None: devices[r[0]]["avg_cpu"] = round(float(r[1]), 2)
                
            # Rata-rata Latensi (Ping)
            cur.execute(f"SELECT device_id, AVG(latency_ms) FROM device_metrics WHERE latency_ms IS NOT NULL AND time > NOW() - INTERVAL '{period}' GROUP BY device_id")
            for r in cur.fetchall():
                if r[0] in devices and r[1] is not None: devices[r[0]]["avg_ping"] = round(float(r[1]), 2)
                
            # SLA (% Uptime) Berdasarkan metrik agregasi
            cur.execute(f"SELECT device_id, status, COUNT(*) FROM device_metrics WHERE time > NOW() - INTERVAL '{period}' GROUP BY device_id, status")
            counts = {}
            for r in cur.fetchall():
                dev_id, status, count = r[0], r[1], r[2]
                if dev_id not in counts: counts[dev_id] = {'UP': 0, 'DOWN': 0}
                if status == 'UP': counts[dev_id]['UP'] += count
                else: counts[dev_id]['DOWN'] += count
                
            for dev_id, c in counts.items():
                total = c['UP'] + c['DOWN']
                if total > 0 and dev_id in devices:
                    devices[dev_id]["sla_percent"] = round((c['UP'] / total) * 100, 2)
                    
    except Exception as e:
        logger.error(f"Error compiling reports: {e}")
    finally:
        if 'conn_ts' in locals() and conn_ts:
            conn_ts.close()
            
    return {"status": "success", "period": period, "data": list(devices.values())}

@app.get("/devices/logs/syslog")
def get_syslogs(limit: int = 200, user: dict = Depends(get_current_user)):
    """Menarik daftar Syslog terbaru dari TimescaleDB untuk Panel System Logs."""
    import os
    try:
        conn = psycopg2.connect(
            host=os.getenv("TIMESCALEDB_HOST", "timescaledb"),
            database=os.getenv("TIMESCALEDB_DB", "nms_metrics"),
            user=os.getenv("TIMESCALEDB_USER", "metrics_user"),
            password=os.getenv("TIMESCALEDB_PASSWORD", "metrics_pass"),
            port=int(os.getenv("TIMESCALEDB_PORT", 5432))
        )
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, timestamp, source_ip, facility, severity, message 
                FROM syslog_events 
                ORDER BY timestamp DESC 
                LIMIT %s;
            """, (limit,))
            result = []
            for r in cur.fetchall():
                result.append({
                    "id": r[0],
                    "timestamp": r[1].isoformat() if r[1] else None,
                    "source_ip": r[2],
                    "facility": r[3],
                    "severity": r[4],
                    "message": r[5]
                })
        return {"status": "success", "data": result}
        return {"status": "error", "data": []}
    finally:
        if 'conn' in locals() and conn:
            conn.close()

class SubnetScanRequest(BaseModel):
    subnet: str
    snmp_communities: list[str] = ["public", "private", "nms"]

@app.post("/devices/discovery/scan")
async def scan_subnet(req: SubnetScanRequest, user: dict = Depends(get_current_user)):
    import ipaddress
    import asyncio
    from pysnmp.hlapi.asyncio import getCmd, SnmpEngine, CommunityData, UdpTransportTarget, ContextData, ObjectType, ObjectIdentity

    try:
        network = ipaddress.ip_network(req.subnet, strict=False)
        if network.num_addresses > 1024:
            raise HTTPException(400, "Subnet terlalu besar. Maksimal /22.")
    except ValueError:
        raise HTTPException(400, "Format subnet tidak valid. (Contoh: 192.168.1.0/24)")

    hosts = [str(ip) for ip in network.hosts()]

    async def ping_host(ip):
        proc = await asyncio.create_subprocess_shell(
            f"ping -c 1 -W 1 {ip}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await proc.communicate()
        return proc.returncode == 0

    async def check_snmp(ip):
        for comm in req.snmp_communities:
            try:
                errorIndication, errorStatus, errorIndex, varBinds = await getCmd(
                    SnmpEngine(),
                    CommunityData(comm, mpModel=0),
                    UdpTransportTarget((ip, 161), timeout=1.0, retries=0),
                    ContextData(),
                    ObjectType(ObjectIdentity('1.3.6.1.2.1.1.1.0'))
                )
                if not errorIndication and not errorStatus:
                    sys_descr = str(varBinds[0][1]).lower()
                    vendor = "Unknown"
                    if "mikrotik" in sys_descr or "routeros" in sys_descr: vendor = "MikroTik"
                    elif "cisco" in sys_descr: vendor = "Cisco"
                    elif "juniper" in sys_descr: vendor = "Juniper"
                    elif "linux" in sys_descr: vendor = "Linux"
                    elif "huawei" in sys_descr: vendor = "Huawei"
                    
                    return {"success": True, "community": comm, "vendor": vendor, "sys_descr": sys_descr[:80]}
            except Exception:
                pass
        return {"success": False}

    async def check_port(ip, port):
        try:
            fut = asyncio.open_connection(ip, port)
            reader, writer = await asyncio.wait_for(fut, timeout=1.0)
            writer.close()
            await writer.wait_closed()
            return True
        except Exception:
            return False

    async def scan_host(ip):
        is_up = await ping_host(ip)
        if not is_up:
            return {"ip": ip, "status": "down"}
            
        snmp_task = check_snmp(ip)
        ssh_task = check_port(ip, 22)
        telnet_task = check_port(ip, 23)
        
        snmp_res, ssh_open, telnet_open = await asyncio.gather(snmp_task, ssh_task, telnet_task)
        
        return {
            "ip": ip,
            "status": "up",
            "snmp": snmp_res,
            "ssh_port_22": ssh_open,
            "telnet_port_23": telnet_open
        }

    semaphore = asyncio.Semaphore(100)
    async def sem_scan(ip):
        async with semaphore:
            return await scan_host(ip)

    tasks = [sem_scan(ip) for ip in hosts]
    results = await asyncio.gather(*tasks)
    
    up_hosts = [r for r in results if r["status"] == "up"]
    return {
        "status": "success", 
        "subnet": req.subnet,
        "scanned": len(hosts), 
        "found": len(up_hosts), 
        "devices": up_hosts
    }

class SystemSettingsUpdate(BaseModel):
    polling_interval_sec: int
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_user: str | None = None
    smtp_pass: str | None = None
    alert_webhook_url: str | None = None

@app.get("/settings")
def get_settings(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM system_settings WHERE id = 'global'")
            row = cur.fetchone()
            if not row:
                return {
                    "polling_interval_sec": 300,
                    "smtp_host": "",
                    "smtp_port": None,
                    "smtp_user": "",
                    "smtp_pass": "",
                    "alert_webhook_url": ""
                }
            return row
    except psycopg2.Error as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.put("/settings")
def update_settings(req: SystemSettingsUpdate, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO system_settings (id, polling_interval_sec, smtp_host, smtp_port, smtp_user, smtp_pass, alert_webhook_url, updated_at)
                VALUES ('global', %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET 
                    polling_interval_sec = EXCLUDED.polling_interval_sec,
                    smtp_host = EXCLUDED.smtp_host,
                    smtp_port = EXCLUDED.smtp_port,
                    smtp_user = EXCLUDED.smtp_user,
                    smtp_pass = EXCLUDED.smtp_pass,
                    alert_webhook_url = EXCLUDED.alert_webhook_url,
                    updated_at = EXCLUDED.updated_at
            """, (req.polling_interval_sec, req.smtp_host, req.smtp_port, req.smtp_user, req.smtp_pass, req.alert_webhook_url))
            conn.commit()
            return {"status": "success"}
    except psycopg2.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.get("/alarms")
def get_alarms(user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT alarm_id, device_id, severity, message, status, created_at, cleared_at, acknowledged_by FROM active_alarms ORDER BY created_at DESC")
            rows = cur.fetchall()
            return rows
    except psycopg2.Error as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.post("/alarms/{alarm_id}/ack")
def ack_alarm(alarm_id: str, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE active_alarms SET status = 'Acknowledged', acknowledged_by = %s WHERE alarm_id = %s",
                (user.get("preferred_username", "admin"), alarm_id)
            )
            conn.commit()
            return {"status": "success"}
    except psycopg2.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

class CompareRequest(BaseModel):
    config_id_1: int
    config_id_2: int

@app.post("/api/config/compare")
def compare_configs(req: CompareRequest, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn: raise HTTPException(status_code=500, detail="Database Error")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, config_text, created_at FROM config_archives WHERE id = %s OR id = %s", (req.config_id_1, req.config_id_2))
            rows = cur.fetchall()
            
            if len(rows) != 2: raise HTTPException(status_code=404, detail="Salah satu/kedua riwayat tidak ditemukan.")
            
            # Sort by ID to ensure consistent Before/After calculation
            rows.sort(key=lambda x: x[0])
            old_conf, new_conf = rows[0], rows[1]
            
            lines1 = old_conf[1].splitlines(keepends=True)
            lines2 = new_conf[1].splitlines(keepends=True)
            
            diff = list(difflib.unified_diff(lines1, lines2, fromfile=f'Versi {old_conf[0]} ({old_conf[2]})', tofile=f'Versi {new_conf[0]} ({new_conf[2]})'))
            diff_text = "".join(diff)
            
            return {
                "is_identical": len(diff) == 0,
                "diff_text": diff_text if len(diff) > 0 else "Kedua konfigurasi identik secara garis besar."
            }
    except psycopg2.Error as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

# --- CONFIG BACKUP & VERSIONING (PHASE 35) ---
@app.post("/api/config/backup/{device_id}")
async def backup_device_config(device_id: str, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
         raise HTTPException(status_code=500, detail="DB Error")
    
    device = None
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id as device_id, ip_address, vendor, ssh_user, ssh_pass, ssh_port, ssh_protocol FROM devices WHERE id = %s", (device_id,))
            device = cur.fetchone()
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=500, detail=str(e))
        
    if not device:
        conn.close()
        raise HTTPException(status_code=404, detail="Device not found")
        
    if device['ssh_protocol'] != 'ssh' or not device['ssh_user']:
        conn.close()
        raise HTTPException(status_code=400, detail="Only SSH devices with credentials are supported for automated backups.")
        
    v = (device['vendor'] or '').lower()
    netmiko_type = "terminal_server"
    cmd = "show running-config"
    if "cisco" in v: netmiko_type = "cisco_ios"
    elif "juniper" in v: 
        netmiko_type = "juniper_junos"
        cmd = "show configuration"
    elif "mikrotik" in v: 
        netmiko_type = "mikrotik_routeros"
        cmd = "export"
        
    def fetch_config():
        payload = {
            "device_type": netmiko_type,
            "host": device['ip_address'],
            "username": device['ssh_user'],
            "password": device['ssh_pass'],
            "port": device['ssh_port'],
            "fast_cli": False,
            "timeout": 15
        }
        with ConnectHandler(**payload) as net_connect:
            return net_connect.send_command(cmd)
            
    try:
        config_text = await asyncio.threads.to_thread(fetch_config)
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=500, detail=f"Failed to fetch config via SSH: {str(e)}")
        
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO config_archives (device_id, config_text, created_at) VALUES (%s, %s, CURRENT_TIMESTAMP) RETURNING id",
                (device_id, config_text)
            )
            archive_id = cur.fetchone()[0]
            conn.commit()
            return {"status": "success", "archive_id": archive_id, "message": "Configuration backed up successfully"}
    except psycopg2.Error as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.get("/api/config/history/{device_id}")
def get_config_history(device_id: str, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, device_id, created_at FROM config_archives WHERE device_id = %s ORDER BY created_at DESC", (device_id,))
            rows = cur.fetchall()
            return rows
    except psycopg2.Error as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.get("/api/config/archive/{archive_id}")
def get_config_archive(archive_id: int, user: dict = Depends(get_current_user)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Database connection unavailable")
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, device_id, config_text, created_at FROM config_archives WHERE id = %s", (archive_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Archive not found")
            return row
    except psycopg2.Error as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

