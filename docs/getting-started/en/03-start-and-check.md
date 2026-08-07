# 03 — Start and check

## Goal

Start the Preview engine, open the Dashboard, confirm `/health` is ok.

## What you need

- [02 — First config](02-first-config.md) done
- A modern browser
- Proxy running if required for your network

## Steps

### 1. Start the engine (recommended)

From the repo root:

```bash
npm run build:dashboard
npm run dev
```

- Run `build:dashboard` on first use or after frontend changes  
- `npm run dev` serves the engine; Dashboard and `/health` share the same port (default **8080**)

Leave this terminal running.

### 2. Open the Dashboard

```
http://127.0.0.1:8080/
```

If you changed `health_port` (e.g. to `8081`), use that port instead.

No login is required on localhost when `DASHBOARD_TOKEN` is unset. Do not expose the port to the public internet.

### 3. Health check

```bash
curl -s http://127.0.0.1:8080/health
```

Expect JSON containing `"status": "ok"` (exact shape may include more fields).

### 4. Quick Dashboard glance

| Page | Expect |
|------|--------|
| Overview | Loads; mode badge **Preview** |
| Leaders | At least one enabled |
| Discover / network pages | Load data; else fix proxy |

### 5. Optional: split frontend dev

```bash
# Terminal 1
npm run dev

# Terminal 2 — proxies to 8080 by default
npm run dev:dashboard
```

Open the Vite URL (usually `http://127.0.0.1:5173`).

If `health_port` is **not** `8080`:

```bash
VITE_API_PORT=8081 npm run dev:dashboard
```

## Success / common failures

**Path A success checklist:**

- [ ] `npm run dev` stays up
- [ ] Dashboard opens in the browser
- [ ] `/health` returns ok
- [ ] At least one Leader enabled

| Symptom | What to do |
|---------|------------|
| Page won’t load | Process running? Port matches `health_port`? Firewall? |
| Blank Dashboard / API errors | Check `VITE_API_PORT` in split mode, or use built Dashboard on the health port |
| Immediate exit / config errors | Recheck `.env` and Preview template |
| Discover fails | Set `HTTPS_PROXY` or `global.proxy` |
| No `PREVIEW would copy` yet | Normal until the Leader trades and passes filters; health + Leader first |

**Next →** [04 — Add a Leader](04-add-leader.md)  
**One-page checklist →** [CHECKLIST.md](CHECKLIST.md)  
**Advanced →** [dashboard/02-getting-started.md](../../dashboard/02-getting-started.md) · [RUNBOOK.md](../../RUNBOOK.md)
