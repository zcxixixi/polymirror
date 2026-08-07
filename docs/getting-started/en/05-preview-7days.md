# 05 — Preview for a few days (plain language)

## Goal

Without spending real money, confirm detection, sensible simulated sizes, and a stable process — before Live.

## What you need

- [04 — Add a Leader](04-add-leader.md) done
- `preview_mode: true` (Overview shows Preview)
- Willingness to watch for several days (not always a strict 7, but finish the full checklist before Live)

Full checklist (incl. SQL): [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)  
One-page deploy ticks: [CHECKLIST.md](CHECKLIST.md)

## Steps (think in days)

### Day 0 — already done

Install, `.env`, Preview template, one Leader, `/health` ok → [CHECKLIST.md](CHECKLIST.md).

### Day 1–2 — can you “see” them?

1. Check the Leader has recent trades on polymarket.com  
2. Look for detect / preview-copy in logs or **Activity**  
3. If only SKIP: read the reason, then relax filters if needed  

**Success signal:** at least one `PREVIEW would copy`, or a clear explanation for all SKIPs.

### Day 3–4 — do sizes look right?

1. Compare simulated size to `PERCENTAGE` / `FIXED`  
2. Watch `max_order_usd` / `min_order_usd` caps  
3. Multiple Leaders: conflict behavior acceptable? (details in USER_GUIDE)

### Day 5 — stability

1. Keep the process up for a while (tmux / avoid sleep killing it)  
2. Dashboard / `/health` still reachable  
3. (Optional) Telegram works  

### Day 6–7 — go / no-go for Live

1. Review Activity for obvious false copies / misses  
2. Happy with Leaders and limits  
3. Skim [SECURITY.md](../../SECURITY.md)  
4. Only then open [06 — Go Live carefully](06-go-live-careful.md)

## Success / common failures

| Success | Notes |
|---------|--------|
| Preview badge stays on | You did not enable Live early |
| You understand COPY / SKIP | Not a black box |
| Full checklist available | Link to PREVIEW_CHECKLIST |

| Symptom | What to do |
|---------|------------|
| No COPY for days | Inactive Leader / tight filters / proxy → [07-faq](07-faq-troubleshoot.md) |
| Skip watching, go Live | Strongly discouraged |

**Next →** [06 — Go Live carefully](06-go-live-careful.md) (optional)  
**Advanced →** [PREVIEW_CHECKLIST.md](../../PREVIEW_CHECKLIST.md)
