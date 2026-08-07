# 01 — Install locally

## Goal

Install Node.js ≥ 20, get the repo, run `npm install`, ready for config.

## What you need

- ~500MB disk space
- A terminal (PowerShell / Windows Terminal / macOS Terminal / Linux shell)
- Network access for npm downloads

## Steps

### 1. Install Node.js ≥ 20

```bash
node -v
```

You want `v20.x` or newer (LTS recommended). If the command is missing or the version is below 20:

| OS | Suggestion |
|----|------------|
| Windows / macOS | Install LTS from [nodejs.org](https://nodejs.org), or use [nvm](https://github.com/nvm-sh/nvm) / [fnm](https://github.com/Schniz/fnm) |
| Linux | Distro packages or nvm for Node 20+ |

Open a **new** terminal, then run `node -v` and `npm -v` again.

### 2. Get the code

If you already have the repo:

```bash
cd PolyMirror
```

Otherwise (use your real remote URL):

```bash
git clone https://github.com/laoshalab/polymirror.git PolyMirror
cd PolyMirror
```

### 3. Install dependencies

From the repo root:

```bash
npm install
```

First run may take a few minutes. It should exit without a fatal red error.

> **Mainland China:** if npm is very slow or fails, configure a mirror registry and/or enable your system proxy, then retry.

### 4. Docker is optional (skip for now)

Path A does **not** need Docker. Finish Preview this way first; see the root `README.md` Docker section later if you prefer Compose.

## Success / common failures

| Check | Expected |
|-------|----------|
| `node -v` | `v20` or higher |
| `npm -v` | prints a version |
| `npm install` | exit 0; `node_modules/` exists |

| Symptom | What to do |
|---------|------------|
| `node: command not found` | Node not installed, or terminal not restarted |
| `npm ERR!` network timeouts | Proxy / network / npm registry |
| Permission errors (Linux) | Do not `sudo npm install`; fix ownership or use nvm |

**Next →** [02 — First config](02-first-config.md)  
**Advanced →** [USER_GUIDE.md](../../USER_GUIDE.md) install sections
