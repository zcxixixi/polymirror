# 07 — 常见问题与排障

## 目标

入门阶段最常见的卡点：连不上、代理、端口、403、没有跟单日志。

## 你需要准备

- 知道自己的 `health_port`（模板默认 `8080`）
- 出问题时尽量保留终端最后 30 行日志

## 排障表

### 连不上 / 打不开 Dashboard

| 现象 | 检查 |
|------|------|
| 浏览器无法访问 | `npm run dev` 是否在跑？地址是否 `127.0.0.1` + 正确端口？ |
| 开发模式空白 | `VITE_API_PORT` 是否等于 `health_port`？或改用 `build:dashboard` 同端口访问 |
| Docker / 局域网 403 或要登录 | 是否设置了 `DASHBOARD_TOKEN`？本机未设 Token 则不应强制登录 |

### 代理与「发现」失败

| 现象 | 检查 |
|------|------|
| Discover / 排行榜失败 | `.env` 的 `HTTPS_PROXY`/`HTTP_PROXY`，或 `global.proxy.mode: static` |
| curl 官网 API 超时 | 先让系统代理通，再启引擎 |
| 代理端口写错 | Clash 常见 `7890`，以你本机软件为准 |

### 配置与启动错误

| 现象 | 检查 |
|------|------|
| `POLYMARKET_PRIVATE_KEY is required` | `.env` 是否在仓库根目录、变量名是否拼对 |
| 地址与 EOA 不一致类报错 | 尝试 `POLYMARKET_SIGNATURE_TYPE=1`（或账户类型要求的 `3`） |
| Live trading blocked | 仅 Live 需要；Preview 可忽略。Live 时设 `POLYMIRROR_LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING` |
| yaml 校验失败 | 缩进用空格；对照 `config.preview.template.yaml` |

### 有进程但没有 `PREVIEW would copy`

按顺序查：

1. Leader `enabled: true`？地址/用户名对吗？  
2. Data API 有近期成交吗？（见 [04](04-add-leader.md) 的 curl）  
3. 是否超出 `max_trade_age_hours`（默认常为 1 小时）？  
4. filters 是否过严（价格、sides）？  
5. `enable_copy_trading` 是否为 true？Kill Switch 是否触发？（看 `/health`）

### 端口搞混

| 场景 | 端口 |
|------|------|
| `npm run dev` + 已 build 的 Dashboard | `health_port`（默认 8080） |
| `npm run dev:dashboard` | Vite 5173 → 代理到 `VITE_API_PORT` 或 8080 |
| 你本机若改成 8081 | 浏览器与 curl 都要用 8081 |

### 安全提醒（短）

- 不要把 `.env` 发到聊天群或贴到 Issue  
- 不要把 Dashboard 裸奔到公网；公网必须 Token + 防火墙  
- 不要对来路不明的「跟单脚本」复制粘贴私钥  

## 如何确认成功 + 常见失败

修好后重新勾选 [CHECKLIST.md](CHECKLIST.md)。仍解决不了 → [RUNBOOK.md](../../RUNBOOK.md) 与 [USER_GUIDE.md §13](../../USER_GUIDE.md)，或加入 Telegram 社区 [t.me/laoshalab](https://t.me/laoshalab)（勿在群内粘贴 `.env` / 私钥）。

**上一章 →** [06 — Live](06-go-live-careful.md)  
**回到开头 →** [00 — 概览](00-overview.md)  
**进阶阅读 →** [RUNBOOK.md](../../RUNBOOK.md)
