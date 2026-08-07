# One-page checklist (getting started)

Print or copy this page. Full 7-day acceptance: [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)

---

## Day 0 — it runs

- [ ] Node.js ≥ 20 (`node -v`)
- [ ] `npm install` succeeded
- [ ] Copied `.env.example` → `.env` with key + address
- [ ] Copied `config.preview.template.yaml` → `config.yaml`
- [ ] `preview_mode: true`
- [ ] At least one Leader `enabled: true`
- [ ] Proxy configured if needed
- [ ] `npm run build:dashboard && npm run dev` without fatal errors
- [ ] Dashboard opens (default `http://127.0.0.1:8080/`)
- [ ] `/health` returns ok

→ Chapters: [00](00-overview.md) · [01](01-install-local.md) · [02](02-first-config.md) · [03](03-start-and-check.md)

---

## Day 1 — you follow someone

- [ ] Leader address or username verified
- [ ] Leaders page shows enabled
- [ ] (Optional) Data API curl shows recent activity
- [ ] Saw `PREVIEW would copy`, **or** can explain all SKIPs

→ Chapters: [04](04-add-leader.md) · [07](07-faq-troubleshoot.md)

---

## Preview watch (summary)

- [ ] Simulated sizes match your strategy
- [ ] Process stays up for a while
- [ ] Still on Preview (not Live)

→ [05](05-preview-7days.md) · full [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)

---

## Live (optional · red lines)

- [ ] Preview satisfactory; you accept risk
- [ ] Dedicated small wallet (≤ $20 recommended)
- [ ] `POLYMIRROR_LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING`
- [ ] (Redeem) `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`
- [ ] After `preview_mode: false`, manually verify first 3 orders

→ [06](06-go-live-careful.md)

---

| Field | Value |
|-------|--------|
| Start date | |
| Leaders | |
| Approved for Live | yes / no |
