"""Temporarily serve a generated pattern over HTTP/HTTPS, then remove both routes.

No user images or credentials are read. This is a diagnostic legacy-API probe,
never a production moderation fallback. Run on the authorized existing server.
"""
import binascii
import json
from pathlib import Path
import re
import secrets
import shutil
import struct
import subprocess
import time
import zlib

root = Path('/opt/qingtu-photo-kit')
directory = Path('/usr/share/nginx/html/qingtu-pattern-probe')
directory.mkdir(mode=0o755, exist_ok=True)
name = secrets.token_hex(16) + '.png'
asset = directory / name
snippet = root / 'server/diagnostic-location.conf'
if snippet.exists():
    raise SystemExit('Existing diagnostic route preserved; stop')

def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', binascii.crc32(kind + data) & 0xffffffff)

image = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 128, 128, 8, 2, 0, 0, 0))
image += chunk(b'IDAT', zlib.compress((b'\x00' + bytes([55, 145, 105]) * 128) * 128)) + chunk(b'IEND', b'')
asset.write_bytes(image)
asset.chmod(0o644)
route = '/qingtu-api/diagnostic/' + name
snippet.write_text('location = ' + route + ' {\n alias ' + str(asset) + ';\n'
                   ' default_type image/png;\n access_log /var/log/nginx/qingtu-callback-status.log qingtu_callback;\n}\n')
include = '    include ' + str(snippet) + ';\n'
configs = [Path('/etc/nginx/conf.d/dream-ai.conf'), Path('/etc/nginx/conf.d/www.ai-dreams.xyz.ssl.conf')]
changed = []
try:
    for config in configs:
        original = config.read_text()
        updated, count = re.subn(r'(server_name\s+www\.ai-dreams\.xyz\s*;\s*\n)',
                                 lambda m: m[0] + include, original)
        if count != 1:
            raise RuntimeError('Unexpected virtual host')
        shutil.copy2(str(config), str(root / 'backups' / ('protocol-' + str(int(time.time())) + '-' + config.name)))
        config.write_text(updated)
        changed.append(config)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    time.sleep(1)
    output = subprocess.check_output(['docker', 'exec', '-i', '-e', 'PROBE_PATH=' + route,
                                     'qingtu-photo-server', 'node'],
                                    input=(root / 'server/scripts/probe-download-protocol.js').read_bytes())
    results = json.loads(output)
    print(json.dumps({'submitted': results}), flush=True)
    keys = {r['traceKey'] for r in results if r.get('errcode') == 0 and r.get('traceKey')}
    received = set()
    deadline = time.time() + 180
    while keys - received and time.time() < deadline:
        logs = subprocess.check_output(['docker', 'logs', '--since', '5m', 'qingtu-photo-server'],
                                       universal_newlines=True)
        for line in logs.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            key = event.get('traceKey')
            if event.get('event') == 'wechat_result' and key in keys and key not in received:
                received.add(key)
                print(json.dumps(event), flush=True)
        if keys - received:
            time.sleep(3)
    print(json.dumps({'callbacks_received': len(received), 'accepted': len(keys)}), flush=True)
finally:
    for config in changed:
        config.write_text(config.read_text().replace(include, ''))
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    snippet.unlink()
    asset.unlink()
    print('Temporary pattern and HTTP/HTTPS routes removed', flush=True)
