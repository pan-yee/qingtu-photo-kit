# 拾格图匣

项目已拆分为两个可独立复制、安装、测试和部署的项目。当前仍在同一 Git 仓库中管理；没有创建新的远程仓库，也没有重新部署线上服务。

| 项目 | 目录 | 用途 | 独立检查 |
| --- | --- | --- | --- |
| 前端 | [frontend](./frontend/README.md) | 微信小程序、端侧图片处理、HTTPS 内容安全客户端 | `cd frontend && npm run check` |
| 后端 | [backend](./backend/README.md) | Express / MySQL 内容安全服务、微信登录与回调、Docker 部署 | `cd backend && npm ci && npm run check` |

前端不依赖后端源码或 Node.js 服务端依赖。后端同时保留微信云开发和独立自有部署：在 `frontend/miniprogram/config/index.js` 设置 `contentSecurity.backend`，默认 `'cloud'` 使用原云环境 `photo-d0gn3yvetb21c4a41` 的 `contentSecurity`；改为 `'http'` 调用保留的 `https://www.ai-dreams.xyz/qingtu-api`。修改参数后重新编译，不在异常时自动切换。两套后端分别部署和验证；自有服务仍支持 `MODERATION_MODE=sync`，该参数不影响云模式。

## 开发

在微信开发者工具中导入 **`frontend/`**，不要再导入仓库根目录。前端 API 配置在 `frontend/miniprogram/config/index.js`，AppID 和基础库配置在 `frontend/project.config.json`。

后端配置使用 `backend/.env.example`，真实密钥仅保存在后端 `.env`。后端启动、MySQL、Nginx、回调与现有服务器升级步骤见[后端说明](./backend/README.md)。拆分不会自动搬迁线上 `server/.env` 或更新 Nginx include 路径，升级现有服务器前需保留配置及数据。

在仓库根目录仍可统一验证：

```sh
npm ci --prefix backend
npm run check
```

也可分别运行 `npm run check:frontend`、`npm run check:backend`。当前 173 项测试按归属分为前端 148 项、后端 25 项，保留原有验证并合入最新图片检测和回调测试。

## 独立分发

单独复制 `frontend/` 或 `backend/` 即为完整项目，各自包含 README、LICENSE、package.json、测试及所需配置。后端包含 package-lock.json，前端无第三方 npm 依赖。无需 npm workspace、根目录 node_modules 或跨项目软链接。

接口说明分别保存在两个项目的 `docs/后端接口.md`，单独分发后仍可查阅。旧云开发备用实现归后端 `cloudfunctions/` 管理，默认仍使用自有 HTTPS 服务，不会自动删除腾讯云资源。


## 本次拆分验证

- 分别复制两个项目到独立临时目录：前端 148 项、后端 25 项测试全部通过；后端副本重新执行 `npm ci` 成功。
- 从只有后端文件的目录构建 Docker 镜像成功；容器以非 root 用户加载实际业务模块，HTTP `/health` 检查通过（使用模拟存储，不代表真实 MySQL 或微信联调）。
- 两种 Compose 配置均通过结构检查；真实环境文件和数据库未用于测试。
- 前端模型转换对照及真实样本处理脚本在新目录下重新运行成功。
- 此次未部署线上服务、未改动真实密钥或数据库，也未创建新的 GitHub 仓库。
