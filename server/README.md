# 自有服务器图片内容安全服务

参照 `dream-interpretation-ai` 的 Node.js / Express + MySQL + Docker 方式部署。本服务使用独立容器、数据库及 JWT 密钥；不修改解梦项目，不占用其 3000 端口或 `/api/` 路径。两个本地项目当前配置为同一个 AppID，须核对实际服务器配置后再决定凭据；同一 AppID 对应同一份 AppSecret，不同 AppID 不得混用。

小程序默认地址：`https://www.ai-dreams.xyz/qingtu-api`。图片加工仍在手机本机完成；服务器完成微信身份校验、临时图片接收和微信内容检测。当前部署使用 `MODERATION_MODE=sync`，直接通过微信 `img_sec_check` 获取最终结果；不使用腾讯云函数、云数据库或云存储。异步模式仍可通过 `MODERATION_MODE=async` 显式启用，依赖 `media_check_async` 和可信结果回调。

同步模式在服务器解析原图并生成不裁剪的 JPEG 检测副本，最大 750×1334、体积小于 1 MiB，校正方向并将透明背景合成白色。它只接受真实 JPEG/PNG，限制解码像素和同时处理数量。只有微信明确返回数字 `errcode=0` 才通过；`87014` 拒绝；未知、网络、解析错误均不通过。任务结果绑定上传原图的 SHA-1，客户端仍核对本地文件摘要；检测结束立即删除上传文件，不生成供外部抓取的用户图片 URL。

## 部署前准备

1. 使用图片小程序 `wx2b68d0818781b66d` 对应的 AppSecret；仅在已有服务的实际 AppID 也完全一致时才可复用该 AppSecret。密钥仅填写在服务器的 `.env`，不要提交 Git、放进小程序代码或发到聊天。
2. 确认已有服务器可访问 MySQL、微信服务器接口，并对外提供该域名的有效 HTTPS 服务。保留解梦服务现有的 `/api/` 反向代理。
3. 微信小程序后台配置 `https://www.ai-dreams.xyz` 为 **request 合法域名**。当前客户端通过 `wx.request` 发送二进制图片，不需要云开发环境或 uploadFile 域名。
4. 在对应微信后台配置服务器出口 IP 白名单（如后台要求）；正式环境须完成域名备案和微信主体要求。

## 在服务器安装

将此仓库单独部署到例如 `/opt/qingtu-photo-kit`，不要覆盖解梦项目的部署目录。

```sh
cd /opt/qingtu-photo-kit
cp server/.env.example server/.env
```

编辑 `server/.env`：

- `WX_SECRET`：图片小程序的 AppSecret。
- `MODERATION_MODE`：当前账号已实测同步接口可用，使用 `sync`。不同账号须先运行非个人测试图探测，接口不可用时保持拦截，不得自动跳过检测。
- `JWT_SECRET`、`MEDIA_SIGNING_SECRET`：分别生成至少 32 字符的独立随机值，例如各执行一次 `openssl rand -hex 32`，不要共用。
- `CONTENT_SECURITY_CALLBACK_TOKEN`：微信消息推送 Token，3-32 位英文/数字；可使用 `openssl rand -hex 16`。
- `CONTENT_SECURITY_CALLBACK_AES_KEY`：后台提供或自行安全生成的 43 字符 EncodingAESKey。自动准备脚本会生成仅含英文/数字的规范 Base64 值；手动部署可用后台的随机生成功能，再同步到服务器。两边保持完全一致。
- `DB_PASS`、`MYSQL_ROOT_PASSWORD`：为这个独立 MySQL 实例分别设置强密码；`DB_USER` 使用普通数据库用户，不使用 root。
- `PUBLIC_BASE_URL`：保持 `https://www.ai-dreams.xyz/qingtu-api`；用于对外 API，异步模式还会用它生成短期签名图片地址。

```sh
chmod 600 server/.env
docker compose --env-file server/.env -f server/docker-compose.yml up -d --build
docker compose --env-file server/.env -f server/docker-compose.yml ps
curl -f http://127.0.0.1:3001/health
```

后端启动会检查所有必要密钥，缺配置则拒绝启动。初始化仅在独立数据库中创建 `moderation_jobs`、`moderation_receipts`、`moderation_limits` 三张表，保留任务、回调和限流状态。不要对已有解梦数据库运行本服务的初始化。

默认 Compose 启动独立 MySQL。若服务器希望复用已有 MySQL 实例，可由管理员预先创建独立 `qingtu_photo` 数据库和仅能访问该库的用户，再按实际 Docker 网络修改 Compose 的数据库地址与服务依赖；不要直接沿用解梦数据库和 root 账号。

### 本次现有服务器部署

服务器 `47.116.65.136` 已有宿主机 MySQL 8，使用 `docker-compose.host-db.yml` 连接独立 `qingtu_photo` 数据库和专用普通用户，不另启 MySQL 容器。部署目录为 `/opt/qingtu-photo-kit`，后续操作使用：

```sh
cd /opt/qingtu-photo-kit
docker compose --env-file server/.env -f server/docker-compose.host-db.yml up -d --build
docker exec qingtu-photo-server node server/scripts/verify-store.js
```

按用户明确要求，原 `dream-ai-server` 已停止并将重启策略设为 `no`；旧 HTTPS 根路径改为 410，HTTP 入口跳转 HTTPS，原数据库保留。Nginx 变更前的配置备份保存在部署目录 `backups/`。不要执行原解梦 Compose 的 `up`，否则会人为重新启用旧服务。

此服务器原 Docker Hub 镜像源 DNS 失效，本服务的 `.env` 使用 `NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine` 获取 Docker Official Images 的 Node.js 镜像；没有修改全局 Docker 镜像源。

切换已有部署的模式时，`python3 server/scripts/set-moderation-mode.py sync` 只原子修改模式字段，保留其他凭据，然后重新创建容器。同步模式不依赖消息推送到达；原消息推送配置保留供异步模式使用。

发布后执行 `docker exec -i -w /app/server/scripts qingtu-photo-server node < server/scripts/smoke-sync-moderation.js`，使用隔离测试身份和代码生成的纯色图片验证公网上传、真实微信同步通过、原图摘要绑定和图片删除；不模拟微信成功响应。脚本最后清理自身创建的测试任务和限流记录。此探测使用服务器签发的临时测试 JWT，不能替代客户端 `wx.login` 的真机验收。

## Nginx 和微信回调

把 [`nginx-location.conf`](./nginx-location.conf) 中的两个 `location` 加入现有 `www.ai-dreams.xyz` 的 **443 server 块**，保留原有证书、解梦 `/api/` 和其他网站配置。该配置将 `/qingtu-api/` 转发到本机 3001 并去掉前缀。

```sh
nginx -t
# 检查通过后再执行
systemctl reload nginx
curl -f https://www.ai-dreams.xyz/qingtu-api/health
```

以下消息推送设置适用于**异步模式**；当前同步模式不依赖回调。已有设置可保留。在**图片小程序**后台配置消息推送：

- URL：`https://www.ai-dreams.xyz/qingtu-api/wechat/callback`
- Token：与服务器 `CONTENT_SECURITY_CALLBACK_TOKEN` 一致。
- EncodingAESKey：与服务器 `CONTENT_SECURITY_CALLBACK_AES_KEY` 一致。
- 使用加密安全模式；先通过 URL 验证，再验证 `wxa_media_check` 事件回调。

### 添加图片提示“内容安全校验暂不可用”

先检查任务实际阶段，不要直接把服务错误当成图片违规。可在服务器执行只读聚合诊断（不输出身份、图片路径、摘要或凭据）：

```sh
cd /opt/qingtu-photo-kit
docker exec -i -w /app/server qingtu-photo-server node < server/scripts/diagnose-moderation.js
```

如果 `accepted_by_wechat` 有计数而任务持续 `pending`，且没有可信结果，优先检查微信消息推送是否启用、回调 URL 和服务器 Token/AESKey 是否一致，以及是否使用安全模式。端点本身可访问、stable_token 成功或本地签名探测成功，都不代表微信后台已经配置完毕。

当前服务还会向容器标准输出写入匿名诊断：固定阶段名称、HTTP 状态码、微信数字错误码和布尔校验结果。用 `docker logs --since 5m qingtu-photo-server` 查看；`wechat_submit` 表示调用检测接口的结果，`media` 表示微信取图请求，`callback` 表示推送到达。它们不记录身份、任务 ID、图片路径、查询签名、请求正文或密钥。仅有 `pending` 或检测接口受理不能视为审核通过。

管理员在自己的服务器终端查看下面两项并分别填入后台，不要将输出提交到 Git 或发送到聊天：

```sh
grep -E '^CONTENT_SECURITY_CALLBACK_(TOKEN|AES_KEY)=' /opt/qingtu-photo-kit/server/.env
```

填写 URL `https://www.ai-dreams.xyz/qingtu-api/wechat/callback`、Token、EncodingAESKey，选择安全模式和 JSON，提交并完成管理员扫码及 URL 验证。完成后重新选图生成新任务，检查是否收到可信 `pass`。已超过微信重试窗口的旧任务不一定会补发结果。

若后台提示服务器地址验证失败，可运行 `python3 server/scripts/enable-callback-diagnostics.py`，再提交一次后台配置，查看 `/var/log/nginx/qingtu-callback-status.log`。日志仅包含时间、请求方法和状态码，不含查询参数、URL、IP 或请求体。GET 403 表示请求已到达但未通过校验；GET 200 表示该次请求已返回验证响应；没有新记录则需核对填写的完整 URL、网络及 HTTPS。不要把自测产生的 GET 200 当成微信后台验证成功。脚本先备份现有配置，执行 `nginx -t` 成功后才重载。

若 HTTP 入口日志显示微信验证请求返回 301/308，说明它在进入接口前被跳转了。当前服务器可在启用上述诊断后执行 `python3 server/scripts/fix-http-callback.py`，只将 HTTP 的精确回调路径直接转发到图片服务，保留其他页面的 HTTPS 跳转；脚本针对现有 `dream-ai.conf`，不匹配预期配置时停止。后台仍推荐填写 HTTPS URL。运行 `docker exec -i qingtu-photo-server node < server/scripts/verify-wechat.js` 可检查 HTTP 挑战直接返回 200、未签名请求返回 403，以及 HTTPS 签名和加密挑战通过。

如该 AppID 已有消息接收端，先在现有服务中安排路由转发；不要直接覆盖已有消息推送设置。两个项目若共用 AppID，也共用微信后台的消息推送配置，必须兼容已有业务。当前接收端只接受签名正确、可解密且 AppID 匹配的图片检测事件，不将客户端提交的 `pass` 作为可信结果。

## 图片与日志保留

- 登录时由后端用 `wx.login` 的临时 code 换取该小程序 OpenID，返回最多一小时的独立 JWT；客户端不保存 AppSecret 或微信 access_token，也不持久化 JWT。
- 每张图片必须先分配归属当前用户的任务，上传最多 10 MiB JPG/PNG。同步模式在内存中生成受限检测副本，通过 HTTPS 直接提交微信；异步模式另创建不可覆盖的随机图片副本，再生成有效期不超过 10 分钟的签名链接供微信抓取。签名链接不返回小程序客户端。
- 检测完成即删除原图和检测副本；回调丢失、用户退出、上传失败时有独立清理任务，每分钟清理超过 10 分钟的临时文件和过期元数据。服务正常运行且清理成功时，异常残留最多约 11 分钟；清理失败会暂停新图片任务、让健康检查失败并输出运维提示。停机期间不会运行清理，重启后会补清理，不要承诺停机或存储异常期间也保证该时限。
- Compose 临时图片卷不要做长期备份；如果宿主机有卷快照或外部备份，应排除该卷或按实际策略明确披露。
- Nginx 不记录此路径的访问 URL，避免日志保留图片签名或回调参数；不要启用记录请求体、Authorization、AppSecret、图片原始内容的调试日志。
- 隐私保护指引需按实际情况声明：微信身份标识、选中的图片、相册写入、运营者服务器所在地及用途、微信内容安全服务、实际清理策略。不得继续宣称图片“不上传”。

## 验证和限制

仓库根目录先安装服务端锁定依赖，再执行完整本地检查：

```sh
cd server && npm ci && cd ..
npm run check
```

本地测试覆盖 HTTP 登录与上传、JWT 归属、明确 pending、加密回调、伪造拦截、摘要与文件变化、重复提交、超大图片、限流、签名链接和 TTL 清理。HTTP 测试使用临时文件和模拟微信 API / 数据存储；必须在实际 MySQL 8 和微信后台继续联调，不能视为已经通过真实审核。

上线后用自己的合规图片完成一次：静默登录 → 上传 → 获得 traceId/pending → 收到微信可信 pass → 预览与保存；再验证拒绝、超时、断网、回调丢失和九宫格整批拦截。保留无图片、无密钥的时间、traceId、状态和操作路径作为审核证据。

旧 `cloudfunctions/contentSecurity` 云开发入口仍保留，便于回滚与复用其已测试的纯业务模块；默认配置 `backend: 'http'` 不会调用该云函数。确认自有服务器链路可用后，再由你决定停用云环境或清理旧资源，迁移代码不会自动删除任何腾讯云资源。
