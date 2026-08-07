# 07 — FAQ and troubleshooting

## Goal

Fix the most common beginner blockers: connectivity, proxy, ports, 403, no copy logs.

## What you need

- Your `health_port` (template default `8080`)
- Last ~30 lines of terminal logs when something fails

## Tables

### Cannot open Dashboard

| Symptom | Check |
|---------|--------|
| Browser cannot connect | Is `npm run dev` running? `127.0.0.1` + correct port? |
| Blank UI in split dev | Does `VITE_API_PORT` match `health_port`? Or use built Dashboard on the health port |
| 403 / login on LAN or Docker | Is `DASHBOARD_TOKEN` set? Localhost without token should not force login |

### Proxy / Discover failures

| Symptom | Check |
|---------|--------|
| Discover / leaderboard fails | `HTTPS_PROXY`/`HTTP_PROXY` or `global.proxy.mode: static` |
| curl to Polymarket APIs times out | Fix system proxy first, then restart the engine |
| Wrong proxy port | Clash often uses `7890` — use your app’s port |

### Config / startup errors

| Symptom | Check |
|---------|--------|
| `POLYMARKET_PRIVATE_KEY is required` | `.env` at repo root; spelling of keys |
| Address vs EOA mismatch | Try `POLYMARKET_SIGNATURE_TYPE=1` (or `3` if required) |
| Live trading blocked | Live only; set `POLYMIRROR_LIVE_CONFIRM=I_UNDERSTAND_LIVE_TRADING` |
| YAML validation errors | Spaces for indent; compare `config.preview.template.yaml` |

### Process up but no `PREVIEW would copy`

1. Leader `enabled: true`? Correct address/username?  
2. Recent activity via Data API? (curl in [04](04-add-leader.md))  
3. Outside `max_trade_age_hours`?  
4. Filters too tight?  
5. `enable_copy_trading` true? Kill switch? (`/health`)

### Port confusion

| Scenario | Port |
|----------|------|
| `npm run dev` + built Dashboard | `health_port` (default 8080) |
| `npm run dev:dashboard` | Vite 5173 → proxy to `VITE_API_PORT` or 8080 |
| You changed to 8081 | Browser and curl must use 8081 |

### Short security reminders

- Never paste `.env` into chats or public issues  
- Never expose Dashboard to the internet without Token + firewall  
- Never paste keys into unknown “copy-bot” scripts  

## Success / common failures

Re-tick [CHECKLIST.md](CHECKLIST.md). Still stuck → [RUNBOOK.md](../../RUNBOOK.md) and [USER_GUIDE.md](../../USER_GUIDE.md).

**Previous →** [06 — Live](06-go-live-careful.md)  
**Back to start →** [00 — Overview](00-overview.md)  
**Advanced →** [RUNBOOK.md](../../RUNBOOK.md)
