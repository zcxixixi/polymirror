# 02 — First config

## Goal

Copy the safe Preview template, set the two required wallet env vars, keep `preview_mode: true`.

## What you need

- [01 — Install locally](01-install-local.md) done
- Your Polymarket **proxy / trading wallet** address (`0x` + 40 hex chars)
- The matching **private key** (64 hex chars, with or without `0x`; **never share it or commit it**)

> Preview does **not** place real CLOB orders, but still requires wallet fields to load and validate config.

## Steps

### 1. Copy templates

From the repo root:

```bash
cp .env.example .env
cp config.preview.template.yaml config.yaml
```

- `.env` — secrets (**do not commit**)
- `config.yaml` — leaders and risk (do not commit real personal configs)

### 2. Edit `.env` (minimum two keys)

```bash
POLYMARKET_PRIVATE_KEY=your_private_key
POLYMARKET_ADDRESS=0xyour_proxy_wallet
```

**Common cases:**

| Case | What to do |
|------|------------|
| Address is the Polymarket UI trading wallet and differs from the EOA of the key (most common) | The two lines above are enough; if startup complains about signature type, add `POLYMARKET_SIGNATURE_TYPE=1` or `3` as appropriate (see advanced docs) |
| Unstable API access (e.g. mainland China) | With Clash/V2Ray running locally, uncomment and set e.g. `HTTPS_PROXY=http://127.0.0.1:7890` and `HTTP_PROXY=http://127.0.0.1:7890`, or set `global.proxy` in `config.yaml` below |

**Skip for now:** `POLYMIRROR_LIVE_CONFIRM`, `RELAYER_API_KEY`, Telegram.

### 3. Confirm Preview in `config.yaml`

```yaml
global:
  preview_mode: true
  health_port: 8080
```

The template usually includes sample Leaders. Replace placeholders with a real `address` or `username` when you can. **Keep at least one `enabled: true` Leader** so you can see copy-related logs later.

### 4. (Recommended) Proxy in yaml

```yaml
global:
  proxy:
    mode: static
    static_url: "http://127.0.0.1:7890"   # your local proxy port
```

## Success / common failures

| Success | Notes |
|---------|--------|
| `.env` and `config.yaml` exist | `preview_mode: true` |
| Both wallet fields non-empty | Address starts with `0x` |
| Secrets not staged for git | Check `git status` |

| Symptom | What to do |
|---------|------------|
| Missing `.env.example` | You are not in the repo root |
| Unsure about key format | See [USER_GUIDE.md](../../USER_GUIDE.md); for path A, “it starts” is enough |
| Tempted to go Live | **Don’t** until this getting-started path is done |

**Next →** [03 — Start and check](03-start-and-check.md)  
**Advanced →** [USER_GUIDE.md](../../USER_GUIDE.md) · [.env.example](../../../.env.example)
