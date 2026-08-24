# 跟单策略研究与模拟优先级

结论：排行榜只适合发现候选，不能直接证明可复制盈利。正式评估必须使用官方 Activity、Closed Positions、市场终态、实时订单簿和逐市场费用，并按实际可执行价格连续模拟。

## A 组：优先长期模拟

1. **领域专家跟单**
   - 只复制候选长期稳定盈利的单一类别，不把跨类别总 PnL 混用。
   - 要求近期仍活跃、BUY/SELL/REDEEM 链路完整、去最大盈利后仍为正。

2. **可执行价格跟单**
   - Leader 成交后重新读取订单簿；只有深度足够且价格偏移在门限内才模拟成交。
   - 费用、滑点、最小订单量和信号延迟全部进入成本。

3. **低相关多 Leader 组合**
   - 每名 Leader 独立记账，最终只组合日 PnL 低相关、event/condition 重合较低的策略。
   - 防止单一市场、单日或单个大赢家主导收益。

4. **完整生命周期跟单**
   - 优先选择有稳定 SELL/REDEEM 行为的候选；不仅复制买入，还验证能否在同样条件下退出和结算。

5. **净仓位变化跟单**
   - 把短时间碎单合成 Leader 的净仓位变化，减少重复费用和追单噪声。

## B 组：探索性模拟

1. **多 Leader 共识**：两个以上低相关合格 Leader 在同一 outcome 同向后才入场。
2. **延迟确认**：信号后等待短时间，只有订单簿未明显恶化且方向仍成立才成交。
3. **反向弱钱包**：对长期、跨窗口稳定亏损的钱包买相反 outcome；严格防止幸存者偏差。
4. **大户持仓异动**：从官方 holders/market positions 发现集中增仓，再用 Activity 验证是真实交易而非转账或拆并仓。
5. **价格区间分层**：分别测试中间概率、长尾高胜率和低价 longshot，禁止把三类收益混算。
6. **Maker/Taker 分层**：区分信息交易与做市收益；无法在跟单端复现的 maker rebate/双边报价收益必须剔除。

## 统一淘汰规则

- 官方接口、身份、分页、condition/event 或结算证据不完整。
- 费用和 executable slippage 后 PnL 不为正。
- PF、回撤、Top3 盈利集中度、去 Top1/2/3 后 PnL不达标。
- 活动停止、票面远超模拟资金、退出不可复制或订单簿深度不足。
- 只在历史回测、排行榜、浮盈或单次高胜率上成立。

## 官方与研究依据

- [Polymarket user activity](https://docs.polymarket.com/api-reference/core/get-user-activity)
- [Polymarket trader leaderboard](https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings)
- [Polymarket current positions](https://docs.polymarket.com/api-reference/core/get-current-positions-for-a-user)
- [Polymarket market WebSocket](https://docs.polymarket.com/api-reference/wss/market)
- [Polymarket fee schedule](https://docs.polymarket.com/trading/fees)
- [The Wisdom of the Few: Skilled Traders and Prediction Market Accuracy](https://papers.ssrn.com/sol3/Delivery.cfm/6758662.pdf?abstractid=6758662&mirid=1&type=2)
- [OpenMarket: synchronized Polymarket/Binance data and walk-forward evaluation](https://arxiv.org/abs/2607.26245)
