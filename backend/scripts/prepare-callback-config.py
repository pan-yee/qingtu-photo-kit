"""Normalize an UNUSED callback key for the WeChat form; never displays secrets.

Run only with --unconfigured after the administrator confirms that message push
has not been configured. Existing AppSecret, JWT, media and DB keys are preserved.
"""
import base64
from pathlib import Path
import re
import secrets
import sys

if sys.argv[1:] != ['--unconfigured']:
    raise SystemExit('Requires explicit --unconfigured confirmation; no change')
path = Path(__file__).resolve().parents[1] / '.env'
text = path.read_text()
pattern = r'(?m)^CONTENT_SECURITY_CALLBACK_AES_KEY=([^\r\n]*)$'
matches = list(re.finditer(pattern, text))
if len(matches) != 1:
    raise SystemExit('Callback environment entry is ambiguous; no change')
if re.fullmatch(r'[A-Za-z0-9]{43}', matches[0][1]):
    print('Callback key already fits the form; unchanged')
else:
    value = base64.b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    while not value.isalnum():
        value = base64.b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    updated = re.sub(pattern, lambda _: 'CONTENT_SECURITY_CALLBACK_AES_KEY=' + value, text)
    path.write_text(updated)
    path.chmod(0o600)
    print('Unused callback key adjusted for the form; restart photo container to apply')
