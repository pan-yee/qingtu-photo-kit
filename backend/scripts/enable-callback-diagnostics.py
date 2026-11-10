"""Enable callback status-only Nginx diagnostics (no URL, query, IP or body)."""
from pathlib import Path
import shutil
import subprocess
import time

root = Path(__file__).resolve().parents[1]
location = root / 'nginx-location.conf'
definition = Path('/etc/nginx/conf.d/00-qingtu-callback-log.conf')
text = location.read_text()
original_definition = definition.read_bytes() if definition.exists() else None
backup = root / 'backups' / ('nginx-location-diagnostics-' + str(int(time.time())))
backup.parent.mkdir(exist_ok=True)
shutil.copy2(str(location), str(backup))
try:
    definition.write_text('log_format qingtu_callback "$time_iso8601 $request_method $status";\n'
                          'map $uri $qingtu_callback_log {\n'
                          ' default 0;\n /qingtu-api/wechat/callback 1;\n}\n')
    replacement = 'access_log /var/log/nginx/qingtu-callback-status.log qingtu_callback if=$qingtu_callback_log;'
    if replacement not in text:
        if text.count('access_log off;') != 1:
            raise RuntimeError('Unexpected location configuration')
        location.write_text(text.replace('access_log off;', replacement))
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except Exception:
    location.write_text(text)
    if original_definition is None:
        definition.unlink()
    else:
        definition.write_bytes(original_definition)
    raise
print('Callback status-only diagnostics enabled')
