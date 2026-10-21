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
- `PORT=127.0.0.1:3000`、`SITE_DOMAIN=ic.fxjzai.com`、`TRUST_PROXY=true`（前面有 Cloudflare/Caddy）
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

## Cloudflare / CDN

域名已经走 Cloudflare 代理（橙云）。要点：

1. 边缘 SSL/TLS 模式用 **Full (strict)**；源站 Caddy 用 Let's Encrypt 证书（HTTP-01 挑战能穿过 Cloudflare 到达源站）。
2. 因为 `TRUST_PROXY=true`，应用从 `X-Forwarded-For` / `CF-Connecting-IP` 读访客地址；**故意伪造该头会被用来绕过登录与反馈限流，所以只在确认有反代时才开**。
3. 进阶加固：把 ufw 的 80/443 从 `Anywhere` 收紧到 **Cloudflare 官方 IP 段**，这样别人无法绕过 CDN 直连源站 IP。加入 CDN 后再做。
4. MCP 默认只接受 `SITE_URL` 主机；有额外访问域名时写 `MCP_ALLOWED_HOSTS`。

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
