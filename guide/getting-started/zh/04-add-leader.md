# 04 — 添加第一个 Leader

## 目标

用地址或用户名加上**一个**启用中的 Leader，并确认引擎能识别。

## 你需要准备

- Preview 已按 [03 — 启动与自检](03-start-and-check.md) 跑通
- 目标 Trader：Polymarket `@用户名`，或已知的 proxy 地址 `0x…`

## 步骤

### 方式 A（推荐）：Dashboard 快速添加

1. 打开 Dashboard → **Leaders**（或页面上的「快速添加」区域）
2. 填入：
   - **地址** `0x…`，或 **用户名**（不要带 `@`）
   - **ID**（简短英文，如 `whale_a`；可先用系统建议）
3. 策略先用保守默认即可，例如：
   - 类型 `PERCENTAGE`，`copy_size: 5`～`10`
   - 或 `FIXED`，每笔约 `$5`
4. 保存后确认列表里该 Leader 为 **启用**

引擎会热重载 `config.yaml`，一般**不必**手动重启。

### 方式 B：发现页挑选

1. 打开 **发现**
2. 浏览排行榜 → 点进详情 → **添加为 Leader**
3. 回到 **Leaders** 微调并启用

发现页加载失败 → 先配代理（见 [02-first-config.md](02-first-config.md)）。

### 方式 C：手改 `config.yaml`

```yaml
leaders:
  - id: my_first_leader
    address: "0x..."              # 或改用下一行 username
    # username: "polymarket-handle"
    enabled: true
    weight: 1
    strategy:
      type: PERCENTAGE
      copy_size: 10
    limits:
      max_order_usd: 25
    filters:
      min_price: 0.05
      max_price: 0.85
      sides: ["BUY", "SELL"]
```

保存后若未自动重载，重启 `npm run dev`。

### 如何确认地址对不对（可选）

```bash
curl "https://data-api.polymarket.com/activity?user=0x你的Leader地址&limit=5"
```

应返回近期成交 JSON。无数据 → 地址错了，或该钱包近期没交易。

从个人页找地址：打开 `https://polymarket.com/@用户名` → 开发者工具 Network → 筛选 `activity` → 参数 `user=0x…`。

## 如何确认成功 + 常见失败

| 成功 | 说明 |
|------|------|
| Leaders 列表有 1 个启用 | Dashboard 或 yaml |
| `/health` 仍为 ok | 配置未写坏 |
| （有成交时）日志出现 DETECT / PREVIEW | 可能要等 Leader 交易 |

| 现象 | 怎么办 |
|------|--------|
| 保存 409 / 重复 | 同一地址或用户名已存在 |
| 用户名解析失败 | 检查拼写、网络/代理；或改填 `address` |
| 有成交但不跟 | 看过滤器、价格区间、`max_trade_age_hours`；见 [07-faq](07-faq-troubleshoot.md) |

**下一章 →** [05 — Preview 观察几天](05-preview-7days.md)  
**进阶阅读 →** [dashboard/04-leaders.md](../../dashboard/04-leaders.md) · [USER_GUIDE.md §5](../../USER_GUIDE.md)
