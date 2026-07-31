# pi-tools

Pi 自定义扩展集合，通过 Pi Package 机制分发，多台机器一行命令安装。

## 包含的扩展

| 扩展 | 功能 | 命令 |
|------|------|------|
| `loop.ts` | 循环模式（类似 Claude Code /loop） | `/loop <目标>` |
| `notify.ts` | AI 完成时系统通知 | 自动 |
| `permission-gate.ts` | Codex 风格权限审批（4 种模式） | `/permission` |
| `secret-guard.ts` | 密钥保护（拦截+屏蔽敏感信息） | 自动 + `/secret` 诊断 |

## 安装

```bash
pi install git:github.com/<你的用户名>/pi-tools
```

## 开发

```bash
# 本地测试
pi -e ./extensions/loop.ts

# 发布到 npm（可选）
npm publish
```

## 更新

```bash
pi update pi-tools   # 或 pi update --all
```
