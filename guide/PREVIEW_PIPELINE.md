# 持续模拟盘 pipeline

当前链路固定使用官方 `@polymarket/client` 稳定版，流程为：fresh intake → 1U/2U/5U 单变量账户 → 可执行 orderbook 模拟 → SQLite 连续状态 → 小时报表与盈利门禁。任何候选即使以 `simulationOnlyEnabled` 进入观察，也不会获得实盘资格。

```bash
npm install
npm run preview:pipeline:prepare
npm run preview:pipeline:start -- reports/preview-pipeline/<run-id>
curl -s http://127.0.0.1:18080/health | jq
```

运行目录完全隔离：

- `intake/`：官方 Data/Gamma 证据与 SHA
- `approved-cohort.json`：fresh intake 结果
- `config.preview.yaml`：生成的模拟账户配置
- `data/`：各账户连续 SQLite 状态
- `reports/`：每小时报告、cohort 表与晋级判断

晋级实盘前仍必须满足 [Preview Checklist](PREVIEW_CHECKLIST.md) 和盈利门禁；启动脚本会清空 live confirmation，不能提交实盘订单。
