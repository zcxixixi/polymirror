# 02 — 首次配置

## 目标

复制 Preview 安全模板，填好最少两项钱包环境变量，并保证 `preview_mode: true`。

## 你需要准备

- 已完成 [01 — 本机安装](01-install-local.md)
- Polymarket **代理钱包地址**（页面上显示的交易地址，一般是 `0x` + 40 位十六进制）
- 对应的 **私钥**（64 位 hex，可带或不带 `0x` 前缀；**切勿发给任何人、勿提交到 git**）

> Preview **不会**向 CLOB 真下单，但仍要求填写钱包，用于加载与校验配置。

## 步骤

### 1. 复制模板文件

在仓库根目录：

```bash
cp .env.example .env
cp config.preview.template.yaml config.yaml
```

- `.env` — 密钥与敏感项（**不要提交 git**）
- `config.yaml` — Leader、风控等（本地使用，**不要提交含真实地址的版本**）

### 2. 编辑 `.env`（最少两项）

用任意文本编辑器打开 `.env`，至少设置：

```bash
POLYMARKET_PRIVATE_KEY=你的私钥
POLYMARKET_ADDRESS=0x你的代理钱包地址
```

**常见情况：**

| 情况 | 做法 |
|------|------|
| 地址就是 Polymarket 网页上显示的交易钱包，且与导出私钥的 EOA 不同（最常见） | 上面两项即可；若启动报签名/类型相关错误，再加 `POLYMARKET_SIGNATURE_TYPE=1` 或按账户类型设为 `3`（见进阶文档） |
| 中国大陆访问 API 不稳定 | 本地已开 Clash/V2Ray 等时，可取消注释并改成你的端口，例如：`HTTPS_PROXY=http://127.0.0.1:7890` 与 `HTTP_PROXY=http://127.0.0.1:7890`；或在下一步的 `config.yaml` 里配置 `global.proxy` |

本阶段**不必**填写：`POLYMIRROR_LIVE_CONFIRM`、`RELAYER_API_KEY`、Telegram（Live / 赎回 / 通知以后再说）。

### 3. 确认 `config.yaml` 仍是 Preview

打开 `config.yaml`，确认：

```yaml
global:
  preview_mode: true
  health_port: 8080
```

模板里通常已有示例 Leader。若地址是占位符，下一章启动后可在 Dashboard 修改；也可先改成真实 `address` 或 `username`（详见后续「加 Leader」章）。**入门阶段保持至少一个 `enabled: true` 的 Leader**，否则健康检查能过，但看不到跟单相关日志。

### 4.（推荐）大陆用户：在 yaml 里写代理

若环境变量代理不方便，可在 `config.yaml`：

```yaml
global:
  proxy:
    mode: static
    static_url: "http://127.0.0.1:7890"   # 改成你的本地代理
```

端口以你本机代理软件为准（常见 `7890` / `10809` 等）。

## 如何确认成功 + 常见失败

| 成功 | 说明 |
|------|------|
| 存在 `.env` 与 `config.yaml` | 且 `preview_mode: true` |
| `.env` 里两项非空 | 地址以 `0x` 开头 |
| 未把 `.env` 提交到 git | `git status` 不应准备提交密钥 |

| 现象 | 怎么办 |
|------|--------|
| 找不到 `.env.example` | 确认当前目录是仓库根目录 |
| 私钥格式心里没底 | 进阶见 [USER_GUIDE.md](../../USER_GUIDE.md)；入门只要能启动即可 |
| 想改成 Live | **先不要**；完成本入门路径再说 |

**下一章 →** [03 — 启动与自检](03-start-and-check.md)  
**进阶阅读 →** [USER_GUIDE.md](../../USER_GUIDE.md) 配置章节 · [.env.example](../../../.env.example)
