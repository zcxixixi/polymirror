# 一页勾选清单（入门）

打印或复制本页。完整 7 天验收仍用：[PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)

---

## Day 0 — 能跑起来

- [ ] 已安装 Node.js ≥ 20（`node -v`）
- [ ] `npm install` 成功
- [ ] 已复制 `.env.example` → `.env`，并填写私钥与地址
- [ ] 已复制 `config.preview.template.yaml` → `config.yaml`
- [ ] `preview_mode: true`
- [ ] 至少一个 Leader `enabled: true`
- [ ] （如需）代理已配置
- [ ] `npm run build:dashboard && npm run dev` 无致命错误
- [ ] 浏览器能打开 Dashboard（默认 `http://127.0.0.1:8080/`）
- [ ] `curl` / 浏览器访问 `/health` 为 ok

→ 章节：[00](00-overview.md) · [01](01-install-local.md) · [02](02-first-config.md) · [03](03-start-and-check.md)

---

## Day 1 — 能跟到人

- [ ] Leader 地址或用户名已核实
- [ ] Dashboard Leaders 显示启用
- [ ] （可选）Data API curl 能看到近期成交
- [ ] 出现过 `PREVIEW would copy`，**或**能解释全部 SKIP 的原因

→ 章节：[04](04-add-leader.md) · [07](07-faq-troubleshoot.md)

---

## Preview 观察（摘要）

- [ ] 模拟金额符合预期策略
- [ ] 进程能稳定跑一段时间
- [ ] 未误开 Live

→ 章节：[05](05-preview-7days.md) · 完整清单 [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)

---

## Live（可选 · 红线）

- [ ] Preview 满意且自担风险
- [ ] 专用小额钱包（建议 ≤ $20）
- [ ] `POLYMIRROR_LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING`
- [ ] （赎回）`RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`
- [ ] `preview_mode: false` 后前 3 笔人工核对

→ 章节：[06](06-go-live-careful.md)

---

| 字段 | 填写 |
|------|------|
| 开始日期 | |
| Leader | |
| 是否批准 Live | 是 / 否 |
