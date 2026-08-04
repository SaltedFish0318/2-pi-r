# pi-tools

Pi 自定义扩展集合（Pi Package），通过 GitHub 分发，多台电脑一行命令安装、一条命令更新。

## 📦 安装

```bash
pi install git:github.com/SaltedFish0318/2-pi-r
```

安装后重启 pi（或 `/reload`）生效。

## 🧩 包含的扩展

| 扩展 | 功能 | 是否自动 | 命令 |
|------|------|:--------:|------|
| `questionnaire.ts` | 单题/多题问卷（tab 切换 + 汇总） |
| `notify.ts` | AI 忙完发系统通知 | 自动 | 无 |
| `permission-gate.ts` | Codex 风格权限审批（4 种模式） | 自动 | `/permission` |
| `secret-guard.ts` | 密钥保护（拦截 + 屏蔽敏感信息） | 自动 | `/secret`（诊断用） |
| `pi-computer-use/` | 电脑控制（桌面 + 浏览器自动化，fork 自 [injaneity/pi-computer-use](https://github.com/injaneity/pi-computer-use)，MIT） | 自动 | `/computer-use` |

> **loop.ts 已归档**（v0.3.1）：循环模式改用社区包 `npm:@narumitw/pi-goal`（功能更完善：token 预算、无进展自动暂停、`goal_complete` 结构化完成判定）。安装：`pi install npm:@narumitw/pi-goal`，命令 `/goal`。
>
> 旧版 loop 源码保留在 `extensions-archive/`（**不加载、不维护**），万一以后需要：`pi -e ./extensions-archive/loop.ts` 即可临时使用。

> **question.ts 已归档**（v0.3.2）：交互提问改用社区包 `npm:@juicesharp/rpiv-ask-user-question`（支持单题/多题问卷、typed options）。安装：`pi install npm:@juicesharp/rpiv-ask-user-question`，工具名 `ask_user_question`。
>
> 旧版源码保留在 `extensions-archive/question.ts`（**不加载、不维护**）。

### 🖥️ computer-use（fork 版）

完整源码位于 `pi-computer-use/`，可自由修改。Windows 原生 helper（`windows-bridge.exe`）需在**首次安装的机器**上编译：

```bash
# 在 pi-computer-use/ 目录下（需 Rust 工具链）
node scripts/build-native.mjs --platform windows
```

或在 `pi-computer-use/` 下运行 `npm run build:windows`。

### 🔔 notify.ts — 系统通知

AI 完成工作等待输入时自动发送系统通知。自动识别终端协议：
- Ghostty / iTerm2 / WezTerm / rxvt-unicode（OSC 777）
- Kitty（OSC 99）
- Windows Terminal（Windows Toast）

### 🛡️ permission-gate.ts — 权限审批

类似 Codex 的权限体系，拦截危险操作。

```
/permission                # 打开二级菜单选择模式
/permission read-only      # 直接切换模式
/permission clear          # 清除记住的决定
```

四种模式：

| 模式 | 行为 |
|------|------|
| 🔍 read-only | 只放行读操作 |
| 🤖 auto（默认） | 安全命令自动放行，危险操作询问 |
| ❓ ask | 所有非读操作都询问 |
| ⚡ full-access | 全部放行 |

危险操作拦截范围：`rm -rf`、`sudo`、`chmod 777`、`git push --force`、`git reset --hard`、`npm publish`、`drop database`、`kill -9`、`reboot` 等 25 条规则 + `.env`、`.git/`、`credentials`、`node_modules/` 等敏感路径。

询问弹窗四选项：允许一次 / 总是允许 / 不允许 / 总是不允许。

### 🔐 secret-guard.ts — 密钥保护

自动防护（无需任何操作）：

| 时机 | 行为 |
|------|------|
| 会话启动 | 自动提示已监控的敏感值数量 |
| AI 执行命令 | 命令含敏感值 → 自动阻止 |
| 工具返回结果 | 输出含敏感值 → 替换为 `***redacted***` |

监控来源：环境变量（`*API_KEY*` / `*SECRET*` / `*TOKEN*` / `*PASSWORD*` 等）+ `.env` 文件 + 内置密钥格式（`sk-`、`ghp_`、`AKIA`、JWT、PEM、Bearer 等）。

诊断命令（可选）：`/secret` 查看状态、`/secret scan` 扫描项目、`/secret test` 自检、`/secret refresh` 重新收集。

## 🔄 更新

```bash
pi update git:github.com/SaltedFish0318/2-pi-r
# 或更新所有包
pi update --all
```

## 🪟 跨平台（Ubuntu ↔ Windows）

扩展全部使用 `homedir()` 动态路径，无硬编码，可跨平台运行。`notify.ts` 在 Windows 上自动使用 Windows Toast。

### Windows 安装步骤

```powershell
# 1. 安装 pi
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 2. 安装包
pi install git:github.com/SaltedFish0318/2-pi-r

# 3. 登录
pi
/login
```

### SSH 端口问题（国内网络）

GitHub 22 端口常被墙，配置 SSH 走 443 端口（Ubuntu 的 `~/.ssh/config` 或 Windows 的 `C:\Users\<用户>\.ssh\config`）：

```
Host github.com
    HostName ssh.github.com
    Port 443
    User git
```

## ⚙️ 其他配置（不属于本包）

`permissions.json`（权限模式持久化）是个人配置，不随包分发，装完包后每台机器单独设置：

```bash
/permission        # 选择模式，自动写入 ~/.pi/agent/permissions.json
```

## 📋 /create-goal prompt 模板

把模糊任务转成严格的目标完成契约（借鉴 codex-goal 的契约写法）——**目标驱动工作流的契约预处理器**：

```text
/create-goal 迁移认证到 Vitest
→ AI 输出 [CONTRACT]（判据/验证/约束）
→ 用户复制到 /goal 启动
```

与目标驱动工作流（如 `@narumitw/pi-goal`）的关系：goal 负责执行闭环（契约确认→执行→验证）；create-goal 负责把模糊需求变成高质量契约输入。

## 🛠️ 开发

```bash
git clone git@github.com:SaltedFish0318/2-pi-r.git
npm install        # 安装测试依赖（vitest 等）
npm test           # 运行单元测试（13 个：permission 8 / secret-guard 5）
# 本地测试单个扩展
pi -e ./extensions/notify.ts
# 修改后推送
git add . && git commit -m "update" && git push
```

## 💻 新机器完整安装清单（2-pi-r 同步）

```bash
# 1. 安装包（当前主机的完整清单）
pi install git:github.com/SaltedFish0318/2-pi-r
pi install npm:pi-mcp-adapter
pi install npm:pi-observational-memory
pi install npm:@ff-labs/pi-fff
pi install npm:@narumitw/pi-goal
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:@juicesharp/rpiv-todo
pi install npm:@narumitw/pi-btw
pi install npm:pi-workspace-history
pi install npm:@tmustier/pi-raw-paste
pi install npm:pi-tool-display
pi install npm:@mrclrchtr/supi-context
pi install npm:pi-extmgr
pi install npm:@juanibiapina/pi-extension-settings
pi install npm:@tintinweb/pi-subagents
pi install npm:@demigodmode/pi-web-agent
pi install npm:pi-spark

# 2. 仓库内测试依赖（可选，跑单测用）
cd ~/.pi/agent/git/github.com/SaltedFish0318/2-pi-r && npm install && npm test
```

### 每台机器单独配置（不随仓库同步）

| 项 | 位置 | 说明 |
|----|------|------|
| 模型配置 + API Key | `~/.pi/agent/models.json` | **⚠️ 含密钥，绝不进仓库**。每台机器手动创建/复制 |
| API Key | `~/.pi/agent/auth.json` | 各自登录 opencode-go |
| MCP 服务器 | `~/.config/mcp/mcp.json` | context7 等 |
| 权限模式 | `~/.pi/agent/permissions.json` | `/permission` 设置 |
| 记忆配置 | `~/.pi/agent/settings.json` | `observational-memory` 键（ratio 模式） |
| 配额 cookie | `~/.pi/agent/opencode-cookies.txt` | `/opencode-quota login` 导出 |

### 需要编译的组件

- **pi-computer-use Windows 桥**：新机器需 Rust GNU 工具链编译 `native/windows/bridge-rs`（`npm run build:windows`），生成 `windows-bridge.exe` 替换到 `~/.pi/agent/helpers/pi-computer-use/`
- **pi-computer-use Linux 桥**：在 `pi-computer-use/` 下运行 `node scripts/build-native.mjs --platform linux`（需 Rust 工具链），或设 `PI_COMPUTER_USE_ALLOW_BUILD=1` 安装时自动编译。产物在 `prebuilt/`（已 gitignore，不入仓库）

### 使用注意

- `pi-fff`：在项目目录跑 pi 时用 fffgrep/fffind（主目录会话会全盘扫描，勿用）

## 📝 变更记录

- **0.3.2** question.ts 归档至 `extensions-archive/`（改用 `rpiv-ask-user-question`）；安装清单同步当前主机全部包；明确 models.json（含 API Key）不随仓库同步
- **0.3.1** loop 源码归档至 `extensions-archive/`（不加载、不维护，`pi -e` 可临时启用）
- **0.3.0** 移除 loop.ts（改用社区包 `@narumitw/pi-goal`）；README 同步更新
- **0.2.1** 当前版本
- **0.1.0** 初始版本：loop / notify / permission-gate / secret-guard
