"""Read callback routing metadata from the general log without printing queries/IPs."""
from collections import deque
from pathlib import Path
import json
import re
from urllib.parse import urlsplit

path = Path('/var/log/nginx/access.log')
with path.open(errors='replace') as log:
    lines = deque(log, maxlen=5000)
results = []
for line in lines:
    match = re.search(r'\[([^\]]+)\] "(GET|POST|HEAD) ([^ ]+) HTTP/([0-9.]+)" (\d{3})', line)
    if not match:
        continue
    stamp, method, target, protocol, status = match.groups()
    route = urlsplit(target).path
    if 'wechat/callback' not in route:
        continue
    results.append({'time': stamp, 'method': method, 'protocol': protocol, 'status': int(status),
                    'expectedPath': route == '/qingtu-api/wechat/callback',
                    'shortPath': route == '/wechat/callback'})
print(json.dumps({'general_log_callback_requests': results[-30:]}))
