# 05 — Preview 观察几天（白话版）

## 目标

在 **不花真钱** 的前提下，确认「能发现成交、模拟跟单合理、进程稳得住」，再考虑 Live。

## 你需要准备

- 已完成 [04 — 添加 Leader](04-add-leader.md)
- `preview_mode: true`（总览应显示 Preview）
- 愿意观察至少几天（不必死抠满 7 天，但 Live 前建议对照完整清单）

完整勾选清单（含 SQL 等）：[PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)  
一页部署勾选：[CHECKLIST.md](CHECKLIST.md)

## 步骤（按天理解即可）

### Day 0 — 已经做过

安装、`.env`、Preview 模板、至少一个 Leader、`/health` ok → 见 [CHECKLIST.md](CHECKLIST.md)。

### Day 1–2 — 能不能「看见」

1. 在 polymarket.com 上看你的 Leader 是否有近期成交  
2. 本机日志或 Dashboard **活动流** 是否出现检测 / 模拟跟单  
3. 若只有 SKIP：点开原因（价格过滤、无持仓却 SELL 等），再决定是否放宽 filters  

**成功信号：** 至少出现过 `PREVIEW would copy`，或能解释清楚为何全是 SKIP。

### Day 3–4 — 金额像不像你想的

1. 看模拟跟单金额是否符合 `PERCENTAGE` / `FIXED`  
2. 是否被 `max_order_usd` / `min_order_usd` 卡住  
3. 若跟多个 Leader：同一市场方向冲突时行为是否可接受（进阶见 USER_GUIDE）

### Day 5 — 稳不稳

1. 进程连续跑一段时间（可用 tmux / 不关电脑睡眠策略）  
2. Dashboard / `/health` 仍可访问  
3. （可选）Telegram 通知是否正常  

### Day 6–7 — 再决定要不要 Live

1. 翻一遍活动流：有没有明显误跟、漏跟  
2. 对 Leader 名单与单笔上限是否满意  
3. 读 [SECURITY.md](../../SECURITY.md) 要点  
4. **只有全部舒服了**，再打开 [06 — 谨慎上 Live](06-go-live-careful.md)

## 如何确认成功 + 常见失败

| 成功 | 说明 |
|------|------|
| Preview 徽章一直在 | 未误开 Live |
| 理解自己的 COPY / SKIP | 不是「黑盒在跑」 |
| 完整清单可勾 | 链到 PREVIEW_CHECKLIST |

| 现象 | 怎么办 |
|------|--------|
| 几天都没有 COPY | Leader 不活跃 / 过滤过严 / 代理导致拉不到 activity → [07-faq](07-faq-troubleshoot.md) |
| 想跳过观察直接 Live | 强烈不建议；至少确认过模拟金额与健康检查 |

**下一章 →** [06 — 谨慎上 Live](06-go-live-careful.md)（可选）  
**进阶阅读 →** [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)
