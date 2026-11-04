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
dc() { docker compose -f docker-compose.yml -f deploy/compose.ghcr.yml "$@"; }
# 先核对可恢复的备份；迁移期间不允许定时器重新拉起旧 worker。
# 每一步成功才继续；setup 失败时保持旧服务和定时器停止，先处理迁移错误。
git pull --ff-only &&
dc pull &&
systemctl stop rlradar-worker-window.timer &&
dc stop worker api web &&
dc up -d --no-build db &&
dc run --rm --no-deps setup &&
dc --profile https up -d --no-build api web caddy &&
systemctl start rlradar-worker-window.timer
```

只更新 worker 时（窗口内它会被定时器自动拉起，不需要手动）：

```bash
dc --profile https up -d --no-build worker   # 仅当处在闲时窗口内
```

### 2026-11-04 上游同步与首批补源

引擎从 `e57da5a` 同步至 AIHOT `cd424b0`（95 个提交）。新增 12 个迁移文件，
包含发布时间精度、信源类别/用途、反馈字段和公众号身份索引；还会移除已停用的
`translation_attempts.request_tag` 列。按照上面的停服顺序升级，不能让旧 worker 与新 schema 同时运行。

本站保留红黑品牌、官网入口、模型图片声明、飞书 JSON 2.0 卡片和夜间 worker 策略。
新版“全部动态”的 `browseFloor` 在本站设为 `0`，继续展示原有范围；不直接采用上游的 40 分过滤。
信源类别是新增的可选功能，旧信源不自动分配类别；没有用本站标注样本校准前不改变评分门槛。

`industry/sources.json` 新增以下来源。`setup` 每次执行都会运行幂等 seed，补充缺少的 ID，
保留已有同 ID 信源的启停、配置和后台修改；因此已有站点也会获得新源。

| ID | 来源 | 采集方式 |
| --- | --- | --- |
| `web-anthropic-news` | Anthropic News | 网页文章列表 |
| `web-anthropic-engineering` | Anthropic Engineering | 网页文章列表（原文路径可为 `/research/`） |
| `web-deepseek-updates` | DeepSeek 更新日志 | 按日期、标题锚点拆分更新 |
| `web-minimax-research` | MiniMax Research | 网页文章卡片 |
| `web-cursor-changelog` | Cursor Changelog | 网页更新列表 |
| `rss-qbitai` | 量子位 | `https://www.qbitai.com/feed/`，保留结尾斜杠 |

新增源只公开摘要和原文链接，两个全文许可都关闭；首次每源最多回填 8 条，旧内容按历史归档，
不批量推送。网页源明确请求英文，避免语言协商使列表和正文变成不同语言。
发布后在后台试抓并核对日期、标题、正文及错误记录，尤其检查生产出口访问量子位 RSS 是否正常；
本机不带结尾斜杠的地址曾返回 403。首次采集与处理仍只在夜间窗口发生。

本地验证使用 2026-11-04 获取的 24 份真实订阅/列表快照，对比升级前后共 2854 条候选：
条数、原文链接和发布时间均无变化。51 篇的标题/摘要或 HTML 有差异：主要是正确解码字符实体，
两条摘要在解码后重新截断，另有一篇保留原站标题旁的锚点链接图标；正文文字未变。
六个新增源共解析 101 条候选，全部带日期。这个对比只验证解析，不代表已经在生产完成采集、评分或发布。

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

自动备份已接通 OSS。`cron.ops.backup` 按 `Asia/Shanghai` 的 `10 4 * * *` 执行，
由夜间 worker 运行；白天 worker 停止不影响这个时间点。实际任务与最近结果应查生产
pg-boss schedule 和 `settings` 的 `backup.last`，详细核验台账保存在内部运维文档。

### 配置与保留

使用阿里云 OSS 的 S3 兼容接口。以下均为占位符，按实际桶和地域替换；
`DB_BACKUP_STORE_DOMAIN` 填含桶名的域名，不带协议或路径：

```dotenv
DB_BACKUP_STORE_BUCKET=<bucket>
DB_BACKUP_STORE_REGION=<region>
DB_BACKUP_STORE_DOMAIN=<bucket>.s3.oss-<region>.aliyuncs.com
# DB_BACKUP_STORE_SECRET_ID 和 DB_BACKUP_STORE_SECRET_KEY 只填在服务器受保护配置中
```

凭证保存在权限为 `600` 的生产 `.env`；不要提交真实凭证、备份文件或配置副本。
桶使用私有访问、阻止公共访问和服务端加密。专用 RAM 身份只授予 `daily/`、`weekly/`、
`monthly/` 前缀内的 PutObject / GetObject 及限定前缀的 ListObjects；不授予 DeleteObject 或控制台登录。
过期对象由桶生命周期清理：`daily/` 30 天、`weekly/` 56 天、`monthly/` 366 天。
应用不会替代管理员创建或核验这些云端规则，变更后应在 OSS 后台复核。

每次生成数据库 custom-format `.dump`，有附件时再生成同一时间戳的 `.tar.gz`，文件名使用 UTC。
附件范围为 `uploads/` 和仍需本地保存的 `feedback-screenshots/`；已转发到飞书的图片只保留数据库引用，
图片缓存不入包。本机每类只留最新 3 份。每个文件只上传一次：每月 1 日写 `monthly/`，
其余周日写 `weekly/`，其他日期写 `daily/`，不再额外复制到多个前缀。原有三个前缀的生命周期仍适用，
核验备份时按当日实际前缀查找，不能要求每一天都有 `daily/` 对象。
数据库、附件备份不包含生产 `.env`、镜像或 DNS/CDN 配置，这些恢复资产需另行受保护保存。

### 核验与恢复

1. 核对计划存在、worker 在执行窗口运行，以及 `backup.last` 时间、`uploaded=true` 和对象清单；无附件时只有数据库对象。
2. 从 OSS 下载对象，与任务记录逐一比较大小和 SHA-256；执行 `pg_restore --list`，有附件时再用 `tar -tzf` 检查可读性。
3. 将 dump 恢复到独立临时数据库，在隔离的数据目录恢复附件；核对核心表计数、附件引用和二维码文件，
   再做业务验收。不要直接覆盖生产库。
4. 新凭证或端点变更后重做上传、下载校验与隔离恢复。`uploaded=true` 或归档可列出均不能替代完整恢复演练。

费用按实际存储、请求和恢复下载流量计量；预算提醒不等于硬性停费。
实际资源标识、权限核验、恢复演练记录与费用台账只维护在内部运维文档，不写入公开仓库。

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
  消息统一使用飞书原生卡片（JSON 2.0）：标题以站名“反向加载”开头满足机器人关键词校验，
  红色表示需立即处理、橙色表示今日跟进、绿色表示已恢复，日报和周报使用蓝色。
  正文分区突出影响范围、恢复方式和处理建议，底部显示北京时间和管理后台按钮；
  聊天列表预览包含状态与标题。过长的周报保留前部内容并提示到后台查看，避免超过机器人 20 KB 限制。
  自定义 Webhook 和应用内部群使用同一份卡片，不需要新增权限或数据库迁移。
  Webhook 串行发送，上一条收到答复或失败后至少间隔 600 毫秒，避免超出机器人频率限制。
  Webhook 只用于运维通知；不要提交真实地址。
  机器人拒收、HTTP 或网络错误不能记为发送成功。现有告警检查随 worker 每 10 分钟运行，
  当前白天 worker 停止时也不执行检查；这不是全天独立可用性监控。
- 关于页使用 `site/brand/contact/qr-wechat-personal.jpg`，也可在后台设置中替换。
  用户提供的两张图实际是同一个个人微信链接，因此只展示添加微信入口；点击可查看原图扫码。
