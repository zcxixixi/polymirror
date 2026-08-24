# 00 — What this is

## Goal

In one minute: what PolyMirror does, what it is not, and which path you follow next.

## What you need

- A computer (Windows / macOS / Linux)
- Network access to Polymarket (an **HTTP proxy is often required** in mainland China)
- A Polymarket wallet address + private key (**required even in Preview** for config validation; no real CLOB orders by default)
- (Optional) A Leader to follow: `0x…` address or Polymarket `@username`

## Steps

### 1. One-line pitch

PolyMirror is a **self-hosted copy-trading engine**: it polls Leader fills → sizes them by your rules → **simulates** in Preview, or places real CLOB orders in Live. It includes a local web Dashboard.

### 2. What it is not

| Is | Is not |
|----|--------|
| Self-hosted software you operate | Cloud SaaS that holds your keys |
| Preview by default (no real spend while learning) | “Sign up and copy-trade” web product |
| Keys only in local `.env` | Custodial trading / signing-as-a-service |

Canonical scope: [PRODUCT_SCOPE.md](../../PRODUCT_SCOPE.md).

### 3. This guide teaches path A only

```
Install Node → copy Preview template → fill .env → npm run dev → open Dashboard → check /health
```

**Skip for now:** multi-account, Docker, VPS, turning off Preview for Live.

### 4. Safety default

Everything assumes `preview_mode: true`. Stop if you see Live / real-order instructions until you finish the Preview chapters.

## Success / common failures

| Success | If stuck |
|---------|----------|
| You know to open [01-install-local.md](01-install-local.md) next | Looking for a “sign-up” page → there isn’t one |
| You accept that Preview still needs a key on disk | Unwilling to keep a key locally → do not use this software |

**Next →** [01 — Install locally](01-install-local.md)  
**Advanced →** [PRODUCT_SCOPE.md](../../PRODUCT_SCOPE.md)
