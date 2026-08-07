# 00 — 这是什么

## 目标

用一分钟搞清：PolyMirror 做什么、不做什么，以及你接下来只需要完成哪条路径。

## 你需要准备

- 一台电脑（Windows / macOS / Linux）
- 能访问 Polymarket 网站与 API 的网络（**中国大陆用户通常需要 HTTP 代理**）
- 一个 Polymarket 钱包地址 + 对应私钥（**Preview 也要填**，用于校验配置；默认不会真下单）
- （可选）一个你想跟单的 Leader：`0x…` 地址，或 Polymarket `@用户名`

## 步骤

### 1. 一句话定位

PolyMirror 是跑在你电脑上的**跟单引擎**：轮询 Leader 的成交 → 按你的规则缩放 → 在 **Preview** 下只模拟记账，或在 **Live** 下通过 CLOB 真下单。自带网页控制台（Dashboard）。

### 2. 它不是什么

| 是 | 不是 |
|----|------|
| 自托管软件，你自己运维 | 官网替你托管私钥的云端 SaaS |
| 默认 Preview，不花真钱验证逻辑 | 「注册账号就能跟单」的网页产品 |
| 私钥只在本机 `.env` | 代持仓 / 代签 / 代运维 |

完整边界：[PRODUCT_SCOPE.md](../../PRODUCT_SCOPE.md)。

### 3. 本入门只教这一条路（路径 A）

```
安装 Node → 复制 Preview 模板 → 填 .env → npm run dev → 打开 Dashboard → 确认 /health
```

**本阶段不要做：** 多账户、Docker、VPS、关掉 Preview 去 Live。

### 4. 安全默认

全文默认 `preview_mode: true`。看到「真下单 / Live」字样时停下来，先完成后面的 Preview 章节。

## 如何确认成功 + 常见失败

| 成功 | 失败时 |
|------|--------|
| 你知道接下来要打开 [01-install-local.md](01-install-local.md) | 想找「注册页」→ 没有；这是自托管软件 |
| 接受「Preview 也要私钥」 | 不愿把私钥放本机 → 请勿使用本软件 |

**下一章 →** [01 — 本机安装](01-install-local.md)  
**进阶阅读 →** [PRODUCT_SCOPE.md](../../PRODUCT_SCOPE.md)
