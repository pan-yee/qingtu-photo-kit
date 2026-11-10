"""Remove the HTTP callback redirect while retaining HTTPS for other routes."""
from pathlib import Path
import re
import shutil
import subprocess
import time

path = Path('/etc/nginx/conf.d/dream-ai.conf')
original = path.read_text()
text, count = re.subn(r'    if \(\$host = www\.ai-dreams\.xyz\) \{\s*return 301 https://\$host\$request_uri;\s*\} # managed by Certbot\s*', '', original)
marker = '    location = /qingtu-api/wechat/callback {'
if marker not in text:
    if count != 1 or text.count('    location / {') != 1:
        raise SystemExit('Unexpected HTTP configuration; unchanged')
    callback = '''    location = /qingtu-api/wechat/callback {
        proxy_pass http://127.0.0.1:3001/wechat/callback;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 35s;
        client_max_body_size 256k;
        access_log /var/log/nginx/qingtu-callback-status.log qingtu_callback;
    }
'''
    text = text.replace('    location / {', callback + '    location / {')
backup = Path('/opt/qingtu-photo-kit/backups') / ('http-callback-' + str(int(time.time())))
shutil.copy2(str(path), str(backup))
try:
    path.write_text(text)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except Exception:
    path.write_text(original)
    raise
print('Exact HTTP callback forwards directly; other HTTP paths retain HTTPS redirect')
