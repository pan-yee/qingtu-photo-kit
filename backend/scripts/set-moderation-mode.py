"""Atomically select sync/async mode without displaying or changing credentials."""
import os
from pathlib import Path
import re
import sys
import tempfile

if len(sys.argv) != 2 or sys.argv[1] not in ('sync', 'async'):
    raise SystemExit('Usage: set-moderation-mode.py sync|async')
path = Path(__file__).resolve().parents[1] / '.env'
text = path.read_text()
pattern = r'(?m)^MODERATION_MODE=[^\r\n]*$'
count = len(re.findall(pattern, text))
if count > 1:
    raise SystemExit('Ambiguous moderation mode; unchanged')
line = 'MODERATION_MODE=' + sys.argv[1]
updated = re.sub(pattern, lambda _: line, text) if count else text.rstrip('\n') + '\n' + line + '\n'
fd, temporary = tempfile.mkstemp(prefix='.env.mode-', dir=str(path.parent))
try:
    with os.fdopen(fd, 'w') as file:
        file.write(updated)
        file.flush()
        os.fsync(file.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, str(path))
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('Moderation mode set to ' + sys.argv[1] + '; credentials preserved')
