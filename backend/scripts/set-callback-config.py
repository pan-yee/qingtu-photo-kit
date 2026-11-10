"""Synchronize administrator-provided callback credentials without echo or argv secrets."""
import getpass
import os
from pathlib import Path
import re
import tempfile

token = getpass.getpass('Callback Token: ')
aes_key = getpass.getpass('EncodingAESKey: ')
if not re.fullmatch(r'[A-Za-z0-9]{3,32}', token):
    raise SystemExit('Invalid Token format; no change')
if not re.fullmatch(r'[A-Za-z0-9]{43}', aes_key):
    raise SystemExit('Invalid EncodingAESKey format; no change')
path = Path(__file__).resolve().parents[1] / '.env'
text = path.read_text()
for key, value in [('CONTENT_SECURITY_CALLBACK_TOKEN', token), ('CONTENT_SECURITY_CALLBACK_AES_KEY', aes_key)]:
    text, count = re.subn(r'(?m)^' + key + r'=[^\r\n]*$', lambda _: key + '=' + value, text)
    if count != 1:
        raise SystemExit('Callback environment entry is ambiguous; no change')
fd, temporary = tempfile.mkstemp(prefix='.env.callback-', dir=str(path.parent))
try:
    with os.fdopen(fd, 'w') as file:
        file.write(text)
        file.flush()
        os.fsync(file.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, str(path))
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('Callback configuration synchronized; other server credentials unchanged')
