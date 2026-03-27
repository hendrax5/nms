import psycopg2
from netmiko import ConnectHandler

conn = psycopg2.connect(host='timescaledb', user='metrics_user', password='metrics_pass', dbname='nms_metrics')
cur = conn.cursor()
cur.execute("SELECT ip_address, ssh_user, ssh_pass, ssh_port FROM devices WHERE vendor ILIKE '%mikrotik%'")
router = cur.fetchone()
conn.close()

if router:
    mikrotik = {
        'device_type': 'mikrotik_routeros',
        'host': router[0], 
        'username': router[1] or '',
        'password': router[2] or '', 
        'port': router[3] or 22,
        'global_delay_factor': 2
    }
    print('Connecting to', router[0], '...')
    try:
        with ConnectHandler(**mikrotik) as ch:
            output = ch.send_command('tool traceroute address=1.1.1.1 ?', read_timeout=10)
            print('--- ARGUMENTS ---')
            print(output)
    except Exception as e:
        print('Failed:', e)
else:
    print('No mikrotik found.')
