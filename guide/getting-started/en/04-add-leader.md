# 04 — Add your first Leader

## Goal

Add **one** enabled Leader by address or username, and confirm the engine recognizes it.

## What you need

- Preview running per [03 — Start and check](03-start-and-check.md)
- A target trader: Polymarket `@username`, or a known proxy `0x…`

## Steps

### Option A (recommended): Dashboard quick add

1. Open Dashboard → **Leaders** (or the quick-add section)
2. Enter:
   - **Address** `0x…`, or **username** (no `@`)
   - **ID** (short English id, e.g. `whale_a`; suggestions are fine)
3. Keep a conservative strategy, e.g.:
   - `PERCENTAGE` with `copy_size: 5`–`10`
   - or `FIXED` around `$5` per fill
4. Save and confirm the Leader is **enabled**

The daemon hot-reloads `config.yaml`; a manual restart is usually unnecessary.

### Option B: Discover

1. Open **Discover**
2. Open a trader → **Add as Leader**
3. Tune and enable on **Leaders**

If Discover fails to load → fix proxy first ([02-first-config.md](02-first-config.md)).

### Option C: Edit `config.yaml`

```yaml
leaders:
  - id: my_first_leader
    address: "0x..."
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

Restart `npm run dev` if reload did not pick up the change.

### Optional: verify the address

```bash
curl "https://data-api.polymarket.com/activity?user=0xLEADER&limit=5"
```

You should see recent activity JSON. Empty → wrong address or no recent trades.

To find an address from a profile: `https://polymarket.com/@username` → DevTools → Network → filter `activity` → param `user=0x…`.

## Success / common failures

| Success | Notes |
|---------|--------|
| One enabled Leader | Dashboard or yaml |
| `/health` still ok | Config valid |
| DETECT / PREVIEW when they trade | May need to wait |

| Symptom | What to do |
|---------|------------|
| 409 / duplicate | Same address or username already exists |
| Username resolve failed | Spelling, network/proxy; or use `address` |
| Trades but no copy | Filters, price band, `max_trade_age_hours` → [07-faq](07-faq-troubleshoot.md) |

**Next →** [05 — Preview for a few days](05-preview-7days.md)  
**Advanced →** [dashboard/04-leaders.md](../../dashboard/04-leaders.md) · [USER_GUIDE.md](../../USER_GUIDE.md)
