# Getting Started / 入门

**First time?** Follow this path only — get **Preview** running on your machine, add one Leader, open the Dashboard.  
**第一次用？** 只走这条路径：本机跑起 **Preview** → 加一个 Leader → 打开 Dashboard。

> **Not a SaaS.** You run PolyMirror yourself; private keys stay in your local `.env`.  
> **不是多租户 SaaS。** 自己部署；私钥只在本机 `.env`。详见 [PRODUCT_SCOPE.md](../PRODUCT_SCOPE.md)。

| Language | Guide |
|----------|--------|
| **中文** | [开始阅读 →](zh/00-overview.md) |
| **English** | [Start here →](en/00-overview.md) |

### Time estimate / 预计时间

| Situation | Time |
|-----------|------|
| Node.js ≥ 20 already installed | ~45 minutes |
| From zero (install Node first) | ~60–90 minutes |

### Success looks like / 成功标准

1. Preview process is running (`npm run dev`)
2. Dashboard opens in the browser
3. At least one Leader is enabled
4. `GET /health` returns `"status": "ok"`

### Chapters / 章节

| # | 中文 | English |
|---|------|---------|
| 00 | [概览](zh/00-overview.md) | [Overview](en/00-overview.md) |
| 01 | [本机安装](zh/01-install-local.md) | [Install locally](en/01-install-local.md) |
| 02 | [首次配置](zh/02-first-config.md) | [First config](en/02-first-config.md) |
| 03 | [启动自检](zh/03-start-and-check.md) | [Start & check](en/03-start-and-check.md) |
| 04 | [添加 Leader](zh/04-add-leader.md) | [Add a Leader](en/04-add-leader.md) |
| 05 | [Preview 观察](zh/05-preview-7days.md) | [Preview days](en/05-preview-7days.md) |
| 06 | [谨慎上 Live](zh/06-go-live-careful.md) | [Go Live carefully](en/06-go-live-careful.md) |
| 07 | [FAQ 排障](zh/07-faq-troubleshoot.md) | [FAQ](en/07-faq-troubleshoot.md) |
| ☐ | [一页清单](zh/CHECKLIST.md) | [One-page checklist](en/CHECKLIST.md) |

Advanced manuals stay in [USER_GUIDE.md](../USER_GUIDE.md) and [RUNBOOK.md](../RUNBOOK.md).
