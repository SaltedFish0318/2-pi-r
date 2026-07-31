/**
 * Permission 扩展（Codex 风格权限模式）
 *
 * 类似 Codex 的权限体系，4 种模式：
 *   1. 只读模式 (read-only)   — 只允许读操作，禁止写/编辑/执行
 *   2. 自动模式 (auto)        — 安全命令自动放行，危险操作询问
 *   3. 询问模式 (ask)         — 所有操作都询问
 *   4. 完全访问 (full-access) — 全部放行，不询问
 *
 * 使用：
 *   /permission  — 打开模式选择菜单（二级菜单）
 *
 * 询问时提供 4 个选项（Codex 风格）：
 *   - 允许一次（Allow once）
 *   - 总是允许（Always allow）
 *   - 不允许（Not allowed）
 *   - 总是不允许（Not allowed always）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// =========================================================================
// 类型定义
// =========================================================================

type PermissionMode = "read-only" | "auto" | "ask" | "full-access";

type Decision = "allow" | "deny";

interface PermissionResult {
	action: Decision;
	/** 是否记住决定（总是允许 / 总是不允许） */
	remember: boolean;
}

// =========================================================================
// 模式定义
// =========================================================================

const MODES: { id: PermissionMode; label: string; description: string }[] = [
	{ id: "read-only", label: "🔍 只读模式", description: "只允许读操作，禁止写/编辑/执行" },
	{ id: "auto", label: "🤖 自动模式", description: "安全命令自动放行，危险操作询问" },
	{ id: "ask", label: "❓ 询问模式", description: "所有操作都询问" },
	{ id: "full-access", label: "⚡ 完全访问", description: "全部放行，不询问" },
];

const MODE_LABELS: Record<PermissionMode, string> = {
	"read-only": "🔍 只读模式",
	auto: "🤖 自动模式",
	ask: "❓ 询问模式",
	"full-access": "⚡ 完全访问",
};

// =========================================================================
// 默认配置
// =========================================================================

const READ_COMMANDS = [
	"git status",
	"git diff",
	"git log",
	"git branch",
	"git show",
	"git stash list",
	"ls",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"rg",
	"find",
	"pwd",
	"echo",
	"cd",
	"date",
	"whoami",
	"uname",
	"env",
	"node -v",
	"npm -v",
	"python --version",
	"npx -v",
	"node -e",
	"git remote -v",
	"git config",
];

const DANGEROUS_BASH: { pattern: string; label: string }[] = [
	{ pattern: "\\brm\\s+-rf", label: "强制递归删除 (rm -rf)" },
	{ pattern: "\\brm\\s+--recursive", label: "递归删除 (rm --recursive)" },
	{ pattern: "\\brmdir\\s+/", label: "删除根目录" },
	{ pattern: "\\bdd\\s+", label: "dd 磁盘操作" },
	{ pattern: "\\bmkfs\\b", label: "格式化 (mkfs)" },
	{ pattern: "\\bsudo\\b", label: "sudo 提权" },
	{ pattern: "\\bchmod\\s+777", label: "chmod 777" },
	{ pattern: "\\bchown\\s+\\d+", label: "chown 修改所有者" },
	{ pattern: "git\\s+push\\s+--force", label: "强制推送 (git push --force)" },
	{ pattern: "git\\s+push\\s+-f\\b", label: "强制推送 (git push -f)" },
	{ pattern: "git\\s+reset\\s+--hard", label: "硬重置 (git reset --hard)" },
	{ pattern: "git\\s+clean\\s+-f", label: "清理未跟踪 (git clean -f)" },
	{ pattern: "git\\s+checkout\\s+--\\s+\\.", label: "丢弃全部修改 (git checkout -- .)" },
	{ pattern: "\\bnpm\\s+publish\\b", label: "发布 npm 包" },
	{ pattern: "drop\\s+database", label: "删除数据库" },
	{ pattern: "drop\\s+table", label: "删除数据表" },
	{ pattern: "truncate\\s+table", label: "清空数据表" },
	{ pattern: "kill\\s+-9", label: "强制杀进程 (kill -9)" },
	{ pattern: "\\breboot\\b", label: "重启系统" },
	{ pattern: "\\bshutdown\\b", label: "关机" },
	{ pattern: "\\bpoweroff\\b", label: "关机" },
	{ pattern: "\\bfdisk\\b", label: "磁盘分区 (fdisk)" },
	{ pattern: "curl.*-o\\s+/etc", label: "写入系统目录 (curl -o /etc)" },
	{ pattern: "wget.*-O\\s+/etc", label: "写入系统目录 (wget -O /etc)" },
	{ pattern: "tee\\s+/etc", label: "写入系统目录 (tee /etc)" },
];

const PROTECTED_PATHS = [
	".env",
	".env.local",
	".env.production",
	"credentials",
	"id_rsa",
	"id_ed25519",
	"aws-credentials",
	".pem",
	"secrets.json",
	".npmrc",
	".netrc",
	"node_modules/",
	"dist/",
	".git/",
	"coverage/",
	".gitignore",
];

// =========================================================================
// 配置加载
// =========================================================================

const CONFIG_PATHS = [
	join(homedir(), ".pi", "agent", "permissions.json"),
	join(process.cwd(), ".pi", "permissions.json"),
];

function loadMode(): PermissionMode {
	for (const p of CONFIG_PATHS) {
		try {
			if (existsSync(p)) {
				const cfg = JSON.parse(readFileSync(p, "utf8"));
				if (cfg && cfg.mode && ["read-only", "auto", "ask", "full-access"].includes(cfg.mode)) {
					return cfg.mode as PermissionMode;
				}
			}
		} catch {
			/* ignore */
		}
	}
	return "auto"; // 默认自动模式
}

function saveMode(mode: PermissionMode): void {
	const p = join(homedir(), ".pi", "agent", "permissions.json");
	try {
		const { writeFileSync } = require("fs") as typeof import("fs");
		const existing = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
		writeFileSync(p, JSON.stringify({ ...existing, mode }, null, 2), "utf8");
	} catch (e) {
		console.error("[permission] 保存模式失败:", e);
	}
}

// =========================================================================
// 匹配工具
// =========================================================================

function isReadCommand(command: string): boolean {
	const trimmed = command.trim();
	return READ_COMMANDS.some((p) => trimmed.startsWith(p));
}

function matchDangerous(command: string): { pattern: string; label: string } | null {
	for (const d of DANGEROUS_BASH) {
		try {
			if (new RegExp(d.pattern, "i").test(command)) return d;
		} catch {
			/* skip */
		}
	}
	return null;
}

function matchProtectedPath(path: string): string | null {
	for (const p of PROTECTED_PATHS) {
		if (path.includes(p)) return p;
	}
	return null;
}

// =========================================================================
// 扩展入口
// =========================================================================

export default function (pi: ExtensionAPI) {
	let mode: PermissionMode = loadMode();
	/** 会话内记住的决定 */
	const decisions = new Map<string, Decision>();

	// -----------------------------------------------------------------------
	// 工具函数
	// -----------------------------------------------------------------------
	function decisionKey(type: string, value: string): string {
		return `${type}:${value}`;
	}

	function checkRemembered(key: string): Decision | null {
		return decisions.get(key) ?? null;
	}

	async function askPermission(
		ctx: any,
		title: string,
		detail: string,
	): Promise<PermissionResult> {
		if (!ctx.hasUI) {
			return { action: "deny", remember: false }; // 非交互模式默认拒绝
		}

		const choice = await ctx.ui.select(
			`⚠️ ${title}\n\n${detail}\n\n如何决定？`,
			["✅ 允许一次", "🔁 总是允许", "🚫 不允许", "⛔ 总是不允许"],
		);

		switch (choice) {
			case "✅ 允许一次":
				return { action: "allow", remember: false };
			case "🔁 总是允许":
				return { action: "allow", remember: true };
			case "🚫 不允许":
				return { action: "deny", remember: false };
			case "⛔ 总是不允许":
				return { action: "deny", remember: true };
			default:
				return { action: "deny", remember: false };
		}
	}

	/** 统一询问并应用决定 */
	async function decide(
		ctx: any,
		key: string,
		title: string,
		detail: string,
		blockReason: string,
	): Promise<any> {
		const remembered = checkRemembered(key);
		if (remembered) {
			return remembered === "allow"
				? undefined
				: { block: true, reason: `${blockReason}（已记住的不允许）` };
		}

		const result = await askPermission(ctx, title, detail);
		if (result.remember) {
			decisions.set(key, result.action);
		}
		return result.action === "allow" ? undefined : { block: true, reason: blockReason };
	}

	function updateMode(ctx: any, newMode: PermissionMode) {
		mode = newMode;
		ctx.ui.setStatus(
			"permission",
			ctx.ui.theme.fg("warning", MODE_LABELS[newMode]),
		);
		// 持久化
		saveMode(newMode);
		ctx.ui.notify(`权限模式已切换: ${MODE_LABELS[newMode]}`, "info");
	}

	// -----------------------------------------------------------------------
	// /permission 命令（二级菜单）
	// -----------------------------------------------------------------------
	pi.registerCommand("permission", {
		description: "权限模式：打开菜单选择 read-only / auto / ask / full-access",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();

			// 支持直接指定模式：/permission auto
			if (input) {
				const match = MODES.find((m) => m.id === input || m.label === input);
				if (match) {
					updateMode(ctx, match.id);
					return;
				}
				if (input === "clear") {
					decisions.clear();
					ctx.ui.notify("已清除所有记住的决定", "info");
					return;
				}
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(
					`当前模式: ${MODE_LABELS[mode]}。用法: /permission read-only|auto|ask|full-access`,
					"info",
				);
				return;
			}

			// 打开二级菜单选择模式
			const choice = await ctx.ui.select(
				`⚙️ 权限设置\n\n当前模式: ${MODE_LABELS[mode]}\n记住的决定: ${decisions.size} 条\n\n选择模式：`,
				[...MODES.map((m) => `${m.label} — ${m.description}`), "🗑️ 清除记住的决定"],
			);

			if (!choice) return;

			// 清除决定
			if (choice.startsWith("🗑️")) {
				decisions.clear();
				ctx.ui.notify("已清除所有记住的决定", "info");
				return;
			}

			// 匹配模式
			const selected = MODES.find((m) => choice.startsWith(m.label));
			if (selected) {
				updateMode(ctx, selected.id);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 拦截工具调用
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		// --- 完全访问模式：全部放行 ---
		if (mode === "full-access") return undefined;

		// --- bash 命令 ---
		if (event.toolName === "bash") {
			const command = event.input.command as string;

			// 只读模式：只放行读命令
			if (mode === "read-only") {
				if (isReadCommand(command)) return undefined;
				return {
					block: true,
					reason: "只读模式：禁止执行命令（可用 /permission 切换模式）",
				};
			}

			// 询问模式：所有命令都问（读命令除外，减少打扰）
			if (mode === "ask") {
				if (isReadCommand(command)) return undefined;
				return await decide(
					ctx,
					decisionKey("bash", command.slice(0, 80)),
					"执行命令",
					`$ ${command}`,
					"Blocked by user",
				);
			}

			// 自动模式：只拦截危险命令
			if (mode === "auto") {
				const dangerous = matchDangerous(command);
				if (dangerous) {
					return await decide(
						ctx,
						decisionKey("dangerous", dangerous.label),
						"危险命令",
						`⚠️ ${dangerous.label}\n$ ${command}`,
						"Blocked: dangerous command",
					);
				}
			}
		}

		// --- write / edit ---
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = event.input.path as string;

			// 只读模式：禁止写
			if (mode === "read-only") {
				return {
					block: true,
					reason: "只读模式：禁止写文件（可用 /permission 切换模式）",
				};
			}

			// 保护路径：自动模式下也询问
			const protectedMatch = matchProtectedPath(path);

			// 询问模式：所有写操作都问
			if (mode === "ask") {
				return await decide(
					ctx,
					decisionKey("write", path),
					event.toolName === "write" ? "写文件" : "编辑文件",
					`路径: ${path}`,
					"Blocked by user",
				);
			}

			// 自动模式：只问保护路径
			if (mode === "auto" && protectedMatch) {
				return await decide(
					ctx,
					decisionKey("path", protectedMatch),
					"修改受保护路径",
					`路径: ${path}\n匹配规则: ${protectedMatch}`,
					`Blocked: ${path} is protected`,
				);
			}
		}

		return undefined;
	});
}
