# 06 — 谨慎上 Live（可选 · 红线）

## 目标

在 Preview 满意后，用**专用小额钱包**打开实盘；并配好自动赎回所需的 Relayer（若需要）。

> **红线：** 本章会花真钱。未完成 Preview 观察前，请停在上一章。  
> 亏钱、滑点、Leader 风格变化均由你自己承担；软件不保证收益。

## 你需要准备

- [05 — Preview](05-preview-7days.md) 已做完，且你愿意承担责任
- **专用**跟单钱包，首次建议 ≤ **$20** USDC
- 会看 Polymarket 网页核对订单
- （自动链上赎回）Relayer API Key + 地址

## 步骤

### 1. 再确认一次 Preview 清单

至少：`/health` ok、有过合理的 `PREVIEW would copy`、Leader 与上限你认可。完整项见 [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)。

### 2. 写入 Live 确认词

编辑 `.env`：

```bash
POLYMIRROR_LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING
```

字符串必须完全一致。

### 3.（建议）Relayer — 自动赎回

市场结算后要把 outcome 兑成 USDC，Live + `auto_redeem_on_chain: true` 需要：

```bash
RELAYER_API_KEY=...
RELAYER_API_KEY_ADDRESS=0x...
```

在 Polymarket → **设置 → Relayer API 密钥**（不是「开发者」页的 Builder 密钥）创建。  
`RELAYER_API_KEY_ADDRESS` 必须是该 key **旁边显示的地址**。

并在 `config.yaml`：

```yaml
global:
  execution:
    auto_redeem_on_chain: true
```

未配 Relayer 时：可以跟单，但结算后可能无法自动赎回（需手动在官网赎回）。

### 4. 关闭 Preview

任选其一：

- Dashboard **风险 / 模式** 切换到 Live（按界面确认）  
- 或 `config.yaml`：`preview_mode: false`

### 5. 重启并核对

```bash
# 停掉旧进程后
npm run dev
```

- 总览应为 **Live**（不是 Preview）
- `/health` 仍为 ok
- 前 **3 笔** 订单到 Polymarket 网页人工核对方向、价格、金额

### 6. 出问题立刻停

- Dashboard 关掉跟单 / 禁用 Leader  
- 或停止进程  
- 或 `enable_copy_trading: false`

## 如何确认成功 + 常见失败

| 成功 | 说明 |
|------|------|
| 小额真实成交与预期一致 | 网页与 Dashboard 一致 |
| 确认词与 Relayer（若需要）已配 | 赎回路径可用 |

| 现象 | 怎么办 |
|------|--------|
| `Live trading blocked` | 检查 `POLYMIRROR_LIVE_CONFIRM` 拼写与重启 |
| 下单失败 | 余额 / allowance / 最小下单额 / 代理；见 [07-faq](07-faq-troubleshoot.md) |
| 结算后资金不回 | Relayer 未配或失败；先官网手动赎回，再查日志 |

**下一章 →** [07 — 常见问题](07-faq-troubleshoot.md)  
**进阶阅读 →** [USER_GUIDE.md](../../USER_GUIDE.md) Live 章节 · [RUNBOOK.md](../../RUNBOOK.md) · [SECURITY.md](../../SECURITY.md)
