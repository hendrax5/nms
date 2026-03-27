import psycopg2
from netmiko import ConnectHandler

conn = psycopg2.connect(host='postgres', user='admin', password='admin123', dbname='nms_db')
cur = conn.cursor()
cur.execute("SELECT ip_address, ssh_user, ssh_pass, ssh_port, vendor FROM devices")
routers = cur.fetchall()
conn.close()

for router in routers:
    vendor = router[4].lower() if router[4] else ""
    netmiko_type = "cisco_ios"
    if "mikrotik" in vendor: netmiko_type = "mikrotik_routeros"
    elif "juniper" in vendor: netmiko_type = "juniper_junos"
    elif "huawei" in vendor: netmiko_type = "huawei"
    
    device_dict = {
        'device_type': netmiko_type,
        'host': router[0], 
        'username': router[1] or '',
        'password': router[2] or '', 
        'port': router[3] or 22,
        'global_delay_factor': 2
    }
    print(f"[{netmiko_type}] Connecting to {router[0]} ...")
    try:
        with ConnectHandler(**device_dict) as ch:
            if netmiko_type == "huawei":
                output = ch.send_command('tracert 1.1.1.1', read_timeout=10)
            elif netmiko_type == "mikrotik_routeros":
                output = ch.send_command('tool traceroute address=1.1.1.1 use-dns=no duration=5s', read_timeout=10)
            else:
                output = ch.send_command('traceroute 1.1.1.1', read_timeout=10)
            print(f'--- OUTPUT {router[0]} ---')
            for line in output.split("\n"):
                if line.strip(): print(line)
    except Exception as e:
        print(f'Failed {router[0]}:', e)
