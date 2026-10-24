# 部署说明（RL-Radar 服务器）

面向 `ic.fxjzai.com` 这一套：GitHub Actions 构建镜像 → GHCR → 服务器 `docker compose pull` 运行。
**服务器不构建镜像**（雨云 2 核 2 GB，构建会 OOM）。

## 组成

| 文件 | 作用 |
| --- | --- |
| `../.github/workflows/publish.yml` | 上游 `Check` 通过后构建 `linux/amd64` 镜像并推到 `ghcr.io/fxjzai/rl-radar` |
| `compose.ghcr.yml` | 覆盖文件：去掉 `build`，四个应用服务改用 GHCR 镜像；compose 项目名改为 `rlradar` |
| `rlradar-worker-window.sh` | 只在 DeepSeek 闲时窗口运行 worker 容器（幂等，由 systemd timer 每分钟调一次） |
| `systemd/rlradar-worker-window.{service,timer}` | 上面那个脚本的定时器 |
| `../docker-compose.yml` | 上游文件，**不改**，升级时直接跟随上游 |

## 服务器目录约定

```
/opt/rl-radar           仓库克隆（含 .env，.env 不入库）
/opt/rl-radar/.env      生产配置，权限 600
```

## 首次安装

```bash
apt-get update && apt-get install -y git
git clone https://github.com/fxjzai/rl-radar.git /opt/rl-radar
cd /opt/rl-radar
cp .env.example .env      # 然后按下面「.env 要点」填写
chmod 600 .env

install -m 755 deploy/rlradar-worker-window.sh /opt/rl-radar/deploy/   # 仓库里已带，无需重复
install -m 644 deploy/systemd/rlradar-worker-window.service /etc/systemd/system/
install -m 644 deploy/systemd/rlradar-worker-window.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rlradar-worker-window.timer

dc() { docker compose -f docker-compose.yml -f deploy/compose.ghcr.yml "$@"; }
dc pull
# 注意：这里必须显式列出服务，不要写 `dc up -d --no-build`。
# 原因是 worker 会采集并调用模型（花钱），而它只应该在闲时窗口里跑，
# 由 rlradar-worker-window.timer 负责启停。
dc --profile https up -d --no-build db setup api web caddy
```

然后把闲时窗口定时器打开（它会接管 worker 的启停）：

```bash
systemctl enable --now rlradar-worker-window.timer
```

## .env 要点

- `SITE_URL=https://ic.fxjzai.com`
- `ADMIN_PASSWORD` / `SESSION_SECRET` / `IMG_PROXY_SIGN_SECRET` / `POSTGRES_PASSWORD`：用 `node scripts/init-env.ts` 生成
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`：DeepSeek
- `COLLECT_ENABLED=true`、`MODEL_CALLS_ENABLED=true` —— **配合闲时窗口使用**，别让 worker 在工作时段常驻
- `PORT=127.0.0.1:3000`、`SITE_DOMAIN=ic.fxjzai.com`、`TRUST_PROXY=true`（前面有 Dooki CDN/Caddy）
- **不要设 `EGRESS_PROXY_URL`**：服务器在洛杉矶，海外信源直连即可。那边是国内 fake-IP 代理环境才需要

## 更新流程

```bash
cd /opt/rl-radar
git pull
dc pull
dc --profile https up -d --no-build db setup api web caddy
```

只更新 worker 时（窗口内它会被定时器自动拉起，不需要手动）：

```bash
dc --profile https up -d --no-build worker   # 仅当处在闲时窗口内
```

## 闲时窗口

`deploy/rlradar-worker-window.sh` 默认 **00:30–08:30（北京时间）**，由 `rlradar-worker-window.timer` 每分钟驱动：
窗口内 `up -d worker`，窗口外 `stop worker`。web/api 常驻不参与，它们不调用模型。

改窗口只改脚本里的 `START_MIN` / `END_MIN` 两行。查看动作记录：

```bash
journalctl -u rlradar-worker-window -f
```

改完记得 `systemctl restart rlradar-worker-window.timer` 不需要，但脚本改了要重新 `install` 或直接改 `/opt/rl-radar/deploy/` 下的文件。

## Dooki CDN 与 Cloudflare DNS

`ic.fxjzai.com` 使用 Dooki CDN，Cloudflare 只管理这条域名的 DNS；不要再为此记录开启橙云，避免两层 CDN 叠加。官网 `fxjzai.com` 仍使用 Workers，不受本配置影响。

- Dooki 站点 ID：`4396`，使用现有 Ray-tutu 套餐。
- Cloudflare 记录：`ic` CNAME → `663d4327.dnm.ink`，DNS only，TTL 300 秒。
- CDN 源站：`https://154.12.55.219:443`，Host 跟随访问域名 `ic.fxjzai.com`；不使用公网 IC 域名作为回源地址，以免 DNS 切换后形成循环。
- CDN 已绑定匹配域名的免费 ACME 证书并开启自动续期；源站保留 Caddy 的 HTTPS。接入时用于提前申请边缘证书的临时 ACME 转发已移除。
- 源站 Caddy 不启用 `encode`，向 CDN 返回未压缩正文；Dooki 站点启用内容压缩。不要在回源请求头中强制 `Accept-Encoding`，也不要手工覆盖响应的 `Content-Length` / `Content-Encoding`。
- HTTP 自动 301 跳转 HTTPS，保留路径与参数；启用 HTTP/2 与 HTTP/3，最低 TLS 1.2。
- 仅缓存 `/assets/` 的 GET 响应，边缘缓存 1 天，缓存 key 保留协议、主机、路径和查询参数。只缓存 200，遇 `private`、`no-cache`、`no-store` 或 `Set-Cookie` 跳过；不延长浏览器缓存。
- 其余路径默认不在 CDN 缓存，包括 HTML、导航 `.data`、`/api/`、RSS、后台与登录、MCP POST；遵循应用原本的缓存期限，不叠加动态缓存。后台响应应为 `private, no-store`，未认证管理接口应为 401。
- 发布后验证静态 CSS/JS 的 `X-Cache: HIT`，以及动态接口和后台的 `X-Cache: BYPASS`；用 `node scripts/smoke.ts --base https://ic.fxjzai.com` 检查页面、机器接口和 MCP 握手。

源站目前仍允许公开 80/443。后续如限制入站，应使用 Dooki 官方节点范围，保留证书验证路径；不能继续照旧只允许 Cloudflare IP。`TRUST_PROXY` 仅用于受控反代链，访客地址与限流应在变更代理链后核对。

图标使用原始品牌文件。固定图标 URL 的源站缓存期为 30 天：发布后如仍见旧图标，要同时核对 CDN 与浏览器缓存；清除 CDN 缓存不会清除读者浏览器已经保存的旧图标。

### 响应完整性与压缩边界

IC 实际部署曾复现：源站 gzip 正常，但 CDN 向不接受压缩的客户端解压后仍使用压缩长度，导致 API 超时、HTTP/2 framing error，静态 JS 也可能缓存成空正文。源站不压缩、边缘负责内容协商可避开这条错误路径；修改后还必须刷新 `https://ic.fxjzai.com/assets/` 的既有缓存。

验收不能只看 200 或 `X-Cache: HIT`。分别以 HTTP/1.1、HTTP/2 和无 `Accept-Encoding`、`identity`、`gzip`、`br` 请求 `/api/v1/agent`、`/api/v1/items?limit=1` 及一份实际静态 JS：完整读取正文，比较解码后的字节数与源站 SHA-256，并确认 JSON 可解析。动态接口仍应 BYPASS，后台仍应拒绝匿名请求；边缘压缩开关启用不代表每次响应一定压缩，以实际响应头为准。最后运行站点 smoke 并在浏览器检查交互和控制台。

Caddyfile 修改先在容器内执行 `caddy validate`，通过后再 `caddy reload`，保留修改前的配置。回退压缩设置前也要验证上述矩阵；仅恢复 `encode zstd gzip` 会重新引入当前 CDN 兼容问题。

### 回退

回退只恢复 IC 的 DNS 记录，不改官网或其他域名。当前记录 ID 为 `c433657f8540b19de99dc67db22599f7`。先用 `cf dns records list --zone fxjzai.com --name ic.fxjzai.com` 核对，再恢复为原源站 A 记录并开启 Cloudflare 代理：

```bash
cf dns records edit c433657f8540b19de99dc67db22599f7 --zone fxjzai.com \
  --body '{"type":"A","name":"ic.fxjzai.com","content":"154.12.55.219","ttl":1,"proxied":true}'
```

DNS 和客户端连接缓存需要时间更新。回退后核对响应链路、图标、静态资源、后台以及 MCP；不要凭控制台保存成功判断接管或回退完成。

## 备份

当前已建立 OSS 桶和生命周期规则；RAM 创建被阿里云账户安全验证拦住，暂未接通自动上传，
尚未执行 OSS 下载恢复验证，也尚未设置云端 5 元预算提醒。账户验证完成后继续以下接入。

`ops.backup` 每天北京时间 04:10 备份数据库和上传附件；本机只保留每类最近 3 份。
使用阿里云 OSS 的 S3 兼容接口，生产 `.env` 中配置：

```dotenv
DB_BACKUP_STORE_BUCKET=fxjzai-ic-backups
DB_BACKUP_STORE_REGION=cn-shenzhen
DB_BACKUP_STORE_DOMAIN=fxjzai-ic-backups.oss-cn-shenzhen.aliyuncs.com
# DB_BACKUP_STORE_SECRET_ID 和 DB_BACKUP_STORE_SECRET_KEY 只填在服务器受保护配置中
```

桶使用深圳标准本地冗余、私有访问、阻止公共访问、SSE-OSS 加密。生命周期规则分别为
`daily/` 30 天、`weekly/` 56 天、`monthly/` 366 天；每周日额外写 weekly，每月 1 日额外写 monthly。
`ic-backup` RAM 用户仅允许在这些目录 PutObject / GetObject，以及限定前缀的 ListObjects，
不开控制台登录、不授权 DeleteObject。过期对象由 OSS 生命周期自动删除。

按 2026-10-21 的 6.6 MB 压缩数据库备份测算，约 50 份占 0.33 GB，
以标准本地冗余 0.12 元/GB/月估计约 0.04 元/月；若每份增长到 100 MB，约 0.60 元/月。
另计请求费、附件和恢复下载流量。授权预算为每月 5 元，预算提醒不等于硬性停费。
以阿里云实际账单为准：[OSS 计费](https://help.aliyun.com/zh/oss/understanding-billing/)。

备份成功需同时核对 `settings` 的 `backup.last` 中 `uploaded=true`、OSS 对象大小和 SHA-256，
并把下载的 dump 恢复到独立临时数据库验证；恢复时不要覆盖生产库。新凭证或端点变更后必须重做上传与恢复验证。

## 模型、费用与异常通知

- 默认模型使用官方 `deepseek-flash`，`LLM_VISION=true`；命名预设也声明支持图片。
  真实图片输入已用合成红蓝色块验证，未把访客图片用于接入测试。
- 嵌入模型使用 MCKJ `bge-m3`：`EMBEDDING_BASE_URL=https://aiapi.szmckj.cn/v1`、
  `EMBEDDING_MODEL=bge-m3`、`EMBEDDING_DIMS=0`。不发送供应商可能不支持的 dimensions 参数，
  实测返回 1024 维。专用 Key 只允许 bge-m3 和源站 IP，保存在服务器 `.env`（600）。
- 费用统计是回执 token 用量乘单价的估算，包含缓存命中折扣，不是充值余额或供应商账单。
  `deploy/apply-prices.ts` 为本站闲时 worker 配置 DeepSeek Flash 的人民币单价，先 dry-run，确认后执行：

  ```bash
  docker exec -i rlradar-api-1 node --input-type=module - < deploy/apply-prices.ts
  docker exec -i rlradar-api-1 node --input-type=module - --apply < deploy/apply-prices.ts
  ```

  2026-10-21 核对的每百万 token 单价为输入 1 元、缓存命中 0.02 元、输出 4 元。
  只适用于本站 00:30–08:30 的调用口径；将来开放高峰运行需先更新价格口径。
  [官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
  MCKJ 目前公示 BGE-M3 输入/输出为 0；这不包含自部署机器成本。
- 异常通知使用 `FEISHU_INTERNAL_ENABLED=true` 和 `FEISHU_ALERT_WEBHOOK_URL`，
  消息以站名“反向加载”开头满足机器人关键词校验。Webhook 只用于运维告警；不要提交真实地址。
  机器人拒收、HTTP 或网络错误不能记为发送成功。现有告警检查随 worker 每 10 分钟运行，
  当前白天 worker 停止时也不执行检查；这不是全天独立可用性监控。
- 关于页使用 `site/brand/contact/qr-wechat-personal.jpg`，也可在后台设置中替换。
  用户提供的两张图实际是同一个个人微信链接，因此只展示添加微信入口；点击可查看原图扫码。
