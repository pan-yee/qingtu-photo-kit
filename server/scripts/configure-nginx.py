"""Add the photo location; optionally retire the old dream routes after explicit approval."""
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
target = Path('/etc/nginx/conf.d/www.ai-dreams.xyz.ssl.conf')
include = '    include ' + str(root / 'server/nginx-location.conf') + ';'
original = target.read_text()
updated = original
if not re.search(r'listen\s+443\s+ssl', original):
    raise SystemExit('Expected HTTPS virtual host not found; no change')
if include not in original:
    pattern = r'(server_name\s+www\.ai-dreams\.xyz\s*;)'
    updated, count = re.subn(pattern, lambda match: match[0] + '\n' + include, original)
    if count != 1:
        raise SystemExit('Virtual host is ambiguous; no change')
changes = {target: (original, updated)}
if '--retire-dream' in sys.argv:
    pattern = r'(?ms)(^[ \t]*location\s+/\s*\{)(.*?)(^[ \t]*\})'
    def retire(text, body):
        matches = list(re.finditer(pattern, text))
        if len(matches) != 1:
            raise SystemExit('Root location is ambiguous; no change')
        found = matches[0]
        if 'proxy_pass http://127.0.0.1:3000' not in found[2] and body not in found[2]:
            raise SystemExit('Unexpected root route; no change')
        return text[:found.start()] + '    location / {\n        ' + body + '\n    }' + text[found.end():]
    changes[target] = (original, retire(updated, 'default_type text/plain;\n        return 410 "Dream service retired\\n";'))
    http = Path('/etc/nginx/conf.d/dream-ai.conf')
    text = http.read_text()
    if not re.search(r'server_name\s+www\.ai-dreams\.xyz\s*;', text):
        raise SystemExit('Expected HTTP virtual host not found; no change')
    changes[http] = (text, retire(text, 'return 308 https://$host$request_uri;'))
backups = root / 'backups'
backups.mkdir(exist_ok=True, mode=0o700)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
modified = []
for file, (before, after) in changes.items():
    if before == after:
        continue
    backup = backups / (stamp + '-' + file.name)
    shutil.copy2(file, backup)
    file.write_text(after)
    modified.append((file, backup))
if modified:
    if subprocess.run(['nginx', '-t']).returncode:
        for file, backup in modified:
            shutil.copy2(backup, file)
        raise SystemExit('Nginx validation failed; original config restored and not reloaded')
    if subprocess.run(['systemctl', 'reload', 'nginx']).returncode:
        for file, backup in modified:
            shutil.copy2(backup, file)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=False)
        raise SystemExit('Nginx reload failed; original config restored')
print('Photo location configured; SSL preserved; changed files=' + str(len(modified)))
