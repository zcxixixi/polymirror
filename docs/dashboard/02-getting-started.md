# 安装与登录（Dashboard 短版）

> **完整入门（推荐）：** [中文](../getting-started/zh/00-overview.md) · [English](../getting-started/en/00-overview.md) · [入口](../getting-started/README.md)  
> 下文仅作控制台内速查；安装步骤以 Getting Started 为准，避免与仓库文档漂移。

---

## 环境要求

| 项目 | 要求 |
|------|------|
| Node.js | ≥ 20（推荐 LTS） |
| 网络 | 可访问 Polymarket API（国内常需代理） |
| 浏览器 | Chrome / Firefox / Safari 现代版本 |

---

## 最小启动命令

```bash
cd PolyMirror
npm install
cp .env.example .env
cp config.preview.template.yaml config.yaml
# 编辑 .env（钱包）与 config.yaml（至少一个 Leader，preview_mode: true）
npm run build:dashboard
npm run dev
```

访问：`http://127.0.0.1:8080/`（端口 = `config.yaml` 的 `health_port`，模板默认 **8080**）  
健康检查：`http://127.0.0.1:8080/health`

开发模式（前后端分离）见 [getting-started/zh/03-start-and-check.md](../getting-started/zh/03-start-and-check.md)。若 `health_port` ≠ `8080`：

```bash
VITE_API_PORT=8081 npm run dev:dashboard
```

---

## 登录与访问控制

### 未配置 Token

`.env` 中 **未设置** `DASHBOARD_TOKEN` 时，打开 Dashboard **无需登录**。

> 仅限本机或可信局域网；请勿将端口暴露到公网。

### 已配置 Token

```bash
DASHBOARD_TOKEN=一串足够长的随机字符串
```

| 操作 | 说明 |
|------|------|
| 登录 | 输入与 `.env` 一致的 Token |
| 退出 | 侧边栏底部 **退出登录** |
| 轮换 Token | 修改 `.env` 后重启引擎，重新登录 |

---

## 启动后自检

| 检查项 | 方法 |
|--------|------|
| 引擎存活 | `/health` 或 **总览** 能加载 |
| 钱包正确 | **我的账户** 地址与 Polymarket 一致 |
| Leader 生效 | **Leader 管理** 至少 1 个启用 |
| 外网可达 | **发现 Trader** 能加载（否则配代理） |
| Preview 模式 | **总览** 显示 Preview 徽章 |

全部通过后，等待 Leader 新成交，在 **活动流** 查看 `DETECT` / `COPY`。

---

## 安全须知

- Dashboard 可修改配置、切换 Live、写入私钥，等同控制平面
- 私钥只在本地 `.env`，界面永不回显
- 公网部署务必 `DASHBOARD_TOKEN` + 防火墙；详见 [SECURITY.md](../SECURITY.md)
