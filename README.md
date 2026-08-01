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
| `question.ts` | 交互提问（AI 弹选项让你选，借鉴 bd-dxg/my-pi） |
| `questionnaire.ts` | 单题/多题问卷（tab 切换 + 汇总） |
| `loop.ts` | 循环模式（类似 Claude Code `/loop` / Codex goal） | 手动 | `/loop <目标>` |
| `notify.ts` | AI 忙完发系统通知 | 自动 | 无 |
| `permission-gate.ts` | Codex 风格权限审批（4 种模式） | 自动 | `/permission` |
| `secret-guard.ts` | 密钥保护（拦截 + 屏蔽敏感信息） | 自动 | `/secret`（诊断用） |
| `pi-computer-use/` | 电脑控制（桌面 + 浏览器自动化，fork 自 [injaneity/pi-computer-use](https://github.com/injaneity/pi-computer-use)，MIT） | 自动 | `/computer-use` |

### 🖥️ computer-use（fork 版）

完整源码位于 `pi-computer-use/`，可自由修改。Windows 原生 helper（`windows-bridge.exe`）需在**首次安装的机器**上编译：

```bash
# 在 pi-computer-use/ 目录下（需 Rust 工具链）
node scripts/build-native.mjs --platform windows
```

或在 `pi-computer-use/` 下运行 `npm run build:windows`。

### 🔄 loop.ts — 循环模式

让 AI 持续迭代工作直到目标完成。

```
/loop <目标>            # 开始循环（默认无限轮次）
/loop max=100 <目标>    # 显式限定轮数（上限 200）
/loop pause             # 暂停（保留进度）
/loop resume            # 恢复
/loop stop              # 停止
/loop status            # 查看进度

# ⚡ 自动触发（无需手动启动）
/loop schedule in=30m <目标>        # 30 分钟后自动开始（一次性）
/loop schedule 09:30 <目标>        # 每天 09:30 自动开始
/loop auto list                    # 查看所有自动任务
/loop auto cancel <id>             # 取消自动任务
```

AI 回复末尾的标记约定：
- `[LOOP_CONTINUE]` = 还需要继续，下一轮自动续跑
- `[LOOP_DONE]` = 目标已完成，循环停止

**自动触发**：扩展在 pi 进程内常驻，每 5 秒检查一次任务，到点自动启动循环。loop 是**通用**指令——领域特定需求（如金价盯盘）直接写在目标文本里，由 AI 在循环内自行使用工具实现，例如：`/loop 持续监控伦敦金，跌破 4000 时分析原因并给出操作建议`。pi 关闭后任务失效（如需 pi 关闭也监控，可配合 Windows 计划任务）。

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

## 🛠️ 开发

```bash
git clone git@github.com:SaltedFish0318/2-pi-r.git
npm install        # 安装测试依赖（vitest 等）
npm test           # 运行单元测试（24 个：permission 8 / secret-guard 5 / loop 11）
# 本地测试单个扩展
pi -e ./extensions/loop.ts
# 修改后推送
git add . && git commit -m "update" && git push
```

## 🔧 loop.ts 结构说明（~1100 行，单文件未拆分）

状态机（state）在 factory 闭包内共享，物理拆分需引入模块级状态（跨文件耦合 + 回归风险）；当前单文件分区清晰（持久化/契约/Judge/UI/自动触发/命令路由）+ 24 个单元测试已保证可维护性。

## 💾 持久化文件与多机同步

| 文件 | 内容 | 跨机器 |
|------|------|--------|
| `~/.pi/agent/loop-state.json` | 当前循环状态 | 复制文件即同步 |
| `~/.pi/agent/loop-tasks.json` | 自动触发任务 | 复制文件即同步 |
| 会话 custom entry（appendEntry） | 分支状态 | 跟随会话文件 |

多机使用：把两个 json 复制到另一台机器的 `~/.pi/agent/` 即可恢复循环。

## 📝 变更记录

- **0.1.0** 初始版本：loop / notify / permission-gate / secret-guard
