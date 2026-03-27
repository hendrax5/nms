import asyncio
import logging
from pysnmp.hlapi.asyncio import *

logger = logging.getLogger(__name__)

async def walk_lldp_neighbors(ip_address: str, community: str, port: int = 161) -> list:
    """
    Melakukan SNMP Walk pada tabel lldpRemTable untuk mengambil tetangga LLDP.
    Mengembalikan list kamus berisi: 
    [{"remote_host": "RouterB", "remote_port": "ether2", "local_port_id": "1"}, ...]
    """
    neighbors = []
    
    # OID lldpRemSysName
    base_oid_sysname = '.1.0.8802.1.1.2.1.4.1.1.9'
    # OID lldpRemPortDesc
    base_oid_portdesc = '.1.0.8802.1.1.2.1.4.1.1.7'

    try:
        # 1. Tarik lldpRemSysName
        sysname_map = {} # indeks (suffix) -> sysname
        
        engine = SnmpEngine()
        auth_data = CommunityData(community, mpModel=0)
        transport = UdpTransportTarget((ip_address, port), timeout=2, retries=1)
        
        # Walk SysName
        iterator = nextCmd(engine, auth_data, transport, ContextData(),
                           ObjectType(ObjectIdentity(base_oid_sysname)),
                           lexicographicMode=False)

        while True:
            try:
                errorIndication, errorStatus, errorIndex, varBinds = await iterator.__anext__()
                if errorIndication or errorStatus:
                    break
                for varBind in varBinds:
                    oid_str = str(varBind[0])
                    val_str = str(varBind[1])
                    if val_str:
                        # OID suffix: .lldpRemTimeMark.lldpRemLocalPortNum.lldpRemIndex
                        # Contoh: .1.0.8802.1.1.2.1.4.1.1.9.0.5.1
                        # 0 = TimeMark, 5 = LocalPort, 1 = Index
                        parts = oid_str.split('.')
                        if len(parts) >= 3:
                            suffix = f"{parts[-3]}.{parts[-2]}.{parts[-1]}"
                            local_port = parts[-2]
                            sysname_map[suffix] = {"sysname": val_str, "local_port": local_port}
            except StopAsyncIteration:
                break

        # 2. Tarik lldpRemPortDesc
        portdesc_map = {}
        iterator_port = nextCmd(engine, auth_data, transport, ContextData(),
                                ObjectType(ObjectIdentity(base_oid_portdesc)),
                                lexicographicMode=False)

        while True:
            try:
                errorIndication, errorStatus, errorIndex, varBinds = await iterator_port.__anext__()
                if errorIndication or errorStatus:
                    break
                for varBind in varBinds:
                    oid_str = str(varBind[0])
                    val_str = str(varBind[1])
                    if val_str:
                        parts = oid_str.split('.')
                        if len(parts) >= 3:
                            suffix = f"{parts[-3]}.{parts[-2]}.{parts[-1]}"
                            portdesc_map[suffix] = val_str
            except StopAsyncIteration:
                break

        # 3. Gabungkan Data
        for suffix, sys_info in sysname_map.items():
            port_desc = portdesc_map.get(suffix, "-")
            neighbors.append({
                "remote_host": sys_info["sysname"],
                "remote_port": port_desc,
                "local_port_id": sys_info["local_port"]
            })

        return neighbors

    except Exception as e:
        logger.error(f"Error fetching LLDP from {ip_address}: {e}")
        return []
