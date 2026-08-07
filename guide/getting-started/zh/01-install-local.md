# 01 — 本机安装

## 目标

装好 Node.js ≥ 20，拉下代码，执行 `npm install`，为下一步配置做准备。

## 你需要准备

- 约 500MB 磁盘空间
- 终端（Windows 可用 PowerShell 或 Windows Terminal；macOS / Linux 用自带终端）
- 稳定网络（`npm install` 会从 npm 拉依赖）

## 步骤

### 1. 安装 Node.js ≥ 20

打开终端，检查版本：

```bash
node -v
```

应看到 `v20.x` 或更高（推荐 LTS）。若提示找不到命令，或版本 &lt; 20：

| 系统 | 建议 |
|------|------|
| Windows / macOS | 从 [nodejs.org](https://nodejs.org) 安装 LTS，或用 [nvm](https://github.com/nvm-sh/nvm) / [fnm](https://github.com/Schniz/fnm) |
| Linux | 用发行版包管理器或 nvm 安装 Node 20+ |

装完后**新开一个终端**，再执行 `node -v` 与 `npm -v`。

### 2. 获取代码

若已有仓库目录，进入即可：

```bash
cd PolyMirror
```

若还没有（把地址换成你实际使用的仓库）：

```bash
git clone https://github.com/laoshalab/polymirror.git PolyMirror
cd PolyMirror
```

### 3. 安装依赖

在仓库根目录执行：

```bash
npm install
```

首次可能需要几分钟。结束时不应有红色报错导致退出。

> **中国大陆：** 若 `npm install` 极慢或失败，可先配置国内 npm 镜像，或确保系统代理已开启后再试。

### 4.（可选）本阶段不装 Docker

入门路径 **不需要** Docker。若你更想用 Compose，请先按本路径走通 Preview，再查阅根目录 `README.md` 的 Docker 小节。

## 如何确认成功 + 常见失败

| 检查 | 期望 |
|------|------|
| `node -v` | `v20` 或更高 |
| `npm -v` | 有版本号 |
| `npm install` | 退出码 0；出现 `node_modules/` |

| 现象 | 怎么办 |
|------|--------|
| `node: command not found` | Node 未装好，或终端未重启 |
| `npm ERR!` 网络超时 | 检查代理 / 换网络 / 配置 npm registry |
| 权限错误（Linux） | 不要用 `sudo npm install`；修好目录权限或改用 nvm |

**下一章 →** [02 — 首次配置](02-first-config.md)  
**进阶阅读 →** [USER_GUIDE.md](../../USER_GUIDE.md) 安装章节
