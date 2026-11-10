"""One-time preparation for the explicitly authorized existing dream server.

Run on that server only. No credentials are printed or passed as command arguments.
The source container must use the exact same WeChat AppID. Existing photo DB/user
or environment files cause a safe stop rather than overwriting their credentials.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    env_path = root / '.env'
    if env_path.exists():
        raise RuntimeError('Existing backend .env preserved; preparation is already complete or needs manual review')
    inspected = json.loads(subprocess.check_output(['docker', 'inspect', 'dream-ai-server']))[0]
    source = dict(item.split('=', 1) for item in inspected['Config']['Env'] if '=' in item)
    if source.get('WX_APPID') != 'wx2b68d0818781b66d' or not source.get('WX_SECRET'):
        raise RuntimeError('Source AppID differs or its AppSecret is missing; no credentials copied')
    password = secrets.token_hex(32)
    # 生成仅含英文/数字的规范 Base64 值，兼容后台表单；解码后仍为 32 字节密钥。
    aes_key = base64.b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    while not aes_key.isalnum():
        aes_key = base64.b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    provision = r'''
const mysql = require('mysql2/promise');
(async function () {
  const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const c = await mysql.createConnection(input.database);
  try {
    const [[version]] = await c.query('SELECT VERSION() AS version');
    if (!/^8\./.test(version.version) || /mariadb/i.test(version.version)) throw new Error('MySQL 8 required');
    const [db] = await c.query("SHOW DATABASES LIKE 'qingtu_photo'");
    const [users] = await c.query("SELECT User FROM mysql.user WHERE User='qingtu_photo'");
    if (db.length || users.length) throw new Error('Photo database/user already exists; preserved');
    await c.query('CREATE DATABASE qingtu_photo CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    await c.query("CREATE USER 'qingtu_photo'@'%' IDENTIFIED BY ?", [input.password]);
    await c.query("GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON qingtu_photo.* TO 'qingtu_photo'@'%'");
  } finally { await c.end(); }
})().catch(function () {console.error('Independent database preparation failed; existing data preserved'); process.exitCode=1;});
'''
    database = {'host': source.get('DB_HOST', '127.0.0.1'),
                'port': int(source.get('DB_PORT', '3306')), 'user': source.get('DB_USER', 'root'),
                'password': source.get('DB_PASSWORD') or source.get('DB_PASS', '')}
    # 允许原服务已永久停止；仅复用本机已有镜像运行一次 MySQL 管理脚本。
    result = subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'host', '--entrypoint',
                             'node', inspected['Config']['Image'], '-e', provision],
                            input=json.dumps({'password': password, 'database': database}), universal_newlines=True)
    if result.returncode:
        raise RuntimeError('Independent database preparation did not succeed; no environment file written')
    values = {
        'WX_APPID': source['WX_APPID'], 'WX_SECRET': source['WX_SECRET'],
        'PUBLIC_BASE_URL': 'https://www.ai-dreams.xyz/qingtu-api', 'MODERATION_MODE': 'sync',
        'JWT_SECRET': secrets.token_hex(32), 'MEDIA_SIGNING_SECRET': secrets.token_hex(32),
        'CONTENT_SECURITY_CALLBACK_TOKEN': secrets.token_hex(16),
        'CONTENT_SECURITY_CALLBACK_AES_KEY': aes_key,
        'DB_HOST': 'host.docker.internal', 'DB_PORT': source.get('DB_PORT', '3306'),
        'DB_NAME': 'qingtu_photo', 'DB_USER': 'qingtu_photo', 'DB_PASS': password, 'PORT': '3001',
    }
    # Compose env syntax: generated secrets are hex/base64; reject unsafe legacy values.
    for value in values.values():
        if any(char in value for char in '\n\r$#\'"'):
            raise RuntimeError('A source value needs manual dotenv quoting; no environment file written')
    fd = os.open(str(env_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write('\n'.join(key + '=' + value for key, value in values.items()) + '\n')
    print('Independent photo database/user and server-only environment prepared; no credentials displayed')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
