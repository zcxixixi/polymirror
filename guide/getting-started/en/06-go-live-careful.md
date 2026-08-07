# 06 — Go Live carefully (optional · red lines)

## Goal

After a satisfactory Preview, enable real trading on a **dedicated small wallet**, and configure Relayer if you want auto-redeem.

> **Red line:** This chapter spends real money. Stay on Preview until you are ready.  
> Losses, slippage, and Leader style changes are yours. The software does not promise profit.

## What you need

- [05 — Preview](05-preview-7days.md) done, and you accept the risk
- A **dedicated** copy wallet; first session ≤ **$20** USDC recommended
- Ability to verify orders on the Polymarket website
- (Auto on-chain redeem) Relayer API key + address

## Steps

### 1. Re-check Preview

At least: `/health` ok, sensible `PREVIEW would copy`, Leaders and limits you trust. Full list: [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md).

### 2. Live confirm string

In `.env`:

```bash
POLYMIRROR_LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING
```

Exact match required.

### 3. Relayer (recommended for auto-redeem)

Resolved markets need CTF redeem to return USDC. With Live and `auto_redeem_on_chain: true`:

```bash
RELAYER_API_KEY=...
RELAYER_API_KEY_ADDRESS=0x...
```

Create them under Polymarket → **Settings → Relayer API keys** (not the Builder “Developer” keys).  
`RELAYER_API_KEY_ADDRESS` must be the address shown **next to** that key.

In `config.yaml`:

```yaml
global:
  execution:
    auto_redeem_on_chain: true
```

Without Relayer you may still trade, but auto-redeem can fail (redeem manually on the site).

### 4. Turn off Preview

Either:

- Dashboard **Risk / mode** → Live (confirm in UI), or  
- `config.yaml`: `preview_mode: false`

### 5. Restart and verify

```bash
npm run dev
```

- Overview shows **Live**
- `/health` still ok
- Manually verify the first **3** orders on Polymarket (side, price, size)

### 6. Stop immediately if wrong

- Disable copy / Leaders in Dashboard  
- Or stop the process  
- Or set `enable_copy_trading: false`

## Success / common failures

| Success | Notes |
|---------|--------|
| Small live fills match intent | Site and Dashboard agree |
| Confirm string (+ Relayer if needed) set | Redeem path ready |

| Symptom | What to do |
|---------|------------|
| `Live trading blocked` | Confirm string + restart |
| Order failures | Balance / allowance / min size / proxy → [07-faq](07-faq-troubleshoot.md) |
| Funds stuck after resolve | Relayer missing/failed; redeem on site, then check logs |

**Next →** [07 — FAQ](07-faq-troubleshoot.md)  
**Advanced →** [USER_GUIDE.md](../../USER_GUIDE.md) · [RUNBOOK.md](../../RUNBOOK.md) · [SECURITY.md](../../SECURITY.md)
