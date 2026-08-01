/**
 * 密钥保护扩展（Secret Guard）
 *
 * 防止 AI 意外泄露 API Key、Token、密码等敏感信息：
 *   1. 收集敏感值：环境变量（*API_KEY* / *SECRET* / *TOKEN* / *PASSWORD* 等）
 *      + .env 文件 + 常见密钥格式（sk- / ghp_ / AKIA 等）
 *   2. tool_call 拦截：bash 命令中直接出现敏感值 → 阻止执行
 *   3. tool_result 屏蔽：工具输出中的敏感值 → 替换为 ***redacted***
 *
 * 命令：
 *   /secret        — 查看当前保护状态
 *   /secret scan   — 扫描当前目录 .env 等文件，报告发现的敏感键名（不显示值）
 *   /secret test   — 自检测试
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// =========================================================================
// 敏感键名匹配
// =========================================================================

const SENSITIVE_KEY_PATTERN =
	/(^|_)(API_?KEY|APITOKEN|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY|AUTH|BEARER|SESSION_?KEY|CLIENT_?SECRET)(_|$)/i;

// =========================================================================
// 常见密钥格式（正则）
// =========================================================================

const SECRET_PATTERNS: RegExp[] = [
	/\b(sk-[A-Za-z0-9_-]{20,})\b/g, // OpenAI / Anthropic / DeepSeek
	/\b(ghp_[A-Za-z0-9]{36,})\b/g, // GitHub Personal Access Token
	/\b(gho_[A-Za-z0-9]{36,})\b/g, // GitHub OAuth
	/\b(AKIA[0-9A-Z]{16})\b/g, // AWS Access Key
	/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, // Slack
	/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, // JWT
	/(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g, // PEM 私钥
	/\b(bearer\s+[A-Za-z0-9._-]{20,})\b/gi, // Bearer token
];

// =========================================================================
// 敏感值收集
// =========================================================================

function collectEnvSecrets(): Map<string, string> {
	const secrets = new Map<string, string>();
	for (const [key, value] of Object.entries(process.env)) {
		if (SENSITIVE_KEY_PATTERN.test(key) && value && value.length >= 8) {
			secrets.set(key, value);
		}
	}
	return secrets;
}

function collectEnvFileSecrets(): Map<string, string> {
	const secrets = new Map<string, string>();
	const envPaths = [
		join(process.cwd(), ".env"),
		join(process.cwd(), ".env.local"),
		join(homedir(), ".pi", "agent", ".env"),
	];

	for (const p of envPaths) {
		try {
			if (!existsSync(p)) continue;
			const content = readFileSync(p, "utf8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const eq = trimmed.indexOf("=");
				if (eq <= 0) continue;
				const key = trimmed.slice(0, eq).trim();
				let value = trimmed.slice(eq + 1).trim();
				// 去掉引号
				value = value.replace(/^["']|["']$/g, "");
				if (SENSITIVE_KEY_PATTERN.test(key) && value.length >= 8) {
					secrets.set(`${key} (${p})`, value);
				}
			}
		} catch {
			/* ignore */
		}
	}
	return secrets;
}

// =========================================================================
// 屏蔽工具
// =========================================================================

const REDACTED = "***redacted***";

function redactText(text: string, secrets: Map<string, string>): string {
	let result = text;

	// 1. 字面值屏蔽（长度 >= 8 才屏蔽，避免误伤短字符串）
	for (const value of secrets.values()) {
		if (value.length >= 8 && result.includes(value)) {
			result = result.split(value).join(REDACTED);
		}
	}

	// 2. 模式屏蔽
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, REDACTED);
	}

	return result;
}

/** 检查文本中是否包含敏感值 */
function containsSecret(text: string, secrets: Map<string, string>): string | null {
	for (const [key, value] of secrets) {
		if (value.length >= 8 && text.includes(value)) return key;
	}
	for (const pattern of SECRET_PATTERNS) {
		// 重置 lastIndex，避免 g 标志的状态污染
		pattern.lastIndex = 0;
		if (pattern.test(text)) return `模式: ${pattern}`;
	}
	return null;
}

// =========================================================================
// 扩展入口
// =========================================================================

export default function (pi: ExtensionAPI) {
	// 启动时收集一次（会话内缓存）
	let envSecrets = collectEnvSecrets();
	let envFileSecrets = collectEnvFileSecrets();
	const allSecrets = new Map([...envSecrets, ...envFileSecrets]);

	function refreshSecrets() {
		envSecrets = collectEnvSecrets();
		envFileSecrets = collectEnvFileSecrets();
		allSecrets.clear();
		for (const [k, v] of [...envSecrets, ...envFileSecrets]) allSecrets.set(k, v);
	}

	// -----------------------------------------------------------------------
	// 会话启动时自动报告防护状态（无需任何命令，防护自动生效）
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.notify(
				`🛡️ 密钥保护已自动激活：监控 ${allSecrets.size} 个敏感值 + ${SECRET_PATTERNS.length} 种密钥格式`,
				"info",
			);
		}
	});

	// -----------------------------------------------------------------------
	// /secret 命令（诊断用途——防护本身自动生效，无需命令）
	// -----------------------------------------------------------------------
	pi.registerCommand("secret", {
		description: "密钥保护诊断：/secret | scan | test | refresh",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();

			// --- refresh ---
			if (input === "refresh") {
				refreshSecrets();
				ctx.ui.notify(`已刷新，监控 ${allSecrets.size} 个敏感值`, "info");
				return;
			}

			// --- scan: 扫描项目目录 ---
			if (input === "scan") {
				const found: { file: string; key: string }[] = [];
				const scanPaths = [".env", ".env.local", ".env.production", "config.json", "secrets.json"];
				for (const f of scanPaths) {
					const p = join(process.cwd(), f);
					try {
						if (!existsSync(p)) continue;
						const content = readFileSync(p, "utf8");
						for (const line of content.split("\n")) {
							const eq = line.indexOf("=");
							if (eq <= 0) continue;
							const key = line.slice(0, eq).trim();
							if (SENSITIVE_KEY_PATTERN.test(key)) {
								found.push({ file: f, key });
							}
						}
						// 模式扫描
						for (const pattern of SECRET_PATTERNS) {
							const m = content.match(pattern);
							if (m) found.push({ file: f, key: `模式匹配 (${pattern.source.slice(0, 30)}...)` });
						}
					} catch {
						/* ignore */
					}
				}
				if (found.length === 0) {
					ctx.ui.notify("✅ 未发现明显敏感文件", "success");
				} else {
					ctx.ui.notify(
						`⚠️ 发现 ${found.length} 处敏感项:\n` +
							found.map((f) => `  ${f.file}: ${f.key}`).join("\n"),
						"warning",
					);
				}
				return;
			}

			// --- test: 自检 ---
			if (input === "test") {
				const sample = "sk-test1234567890abcdefghijklmnopqrstuvwxyz";
				const redacted = redactText(sample, allSecrets);
				const ok = redacted.includes(REDACTED);
				ctx.ui.notify(
					ok
						? `✅ 屏蔽功能正常: "${sample.slice(0, 12)}..." → "${redacted}"`
						: "❌ 屏蔽功能异常!",
					ok ? "success" : "error",
				);
				return;
			}

			// --- 默认: 状态 ---
			const envCount = envSecrets.size;
			const fileCount = envFileSecrets.size;
			ctx.ui.notify(
				`🛡️ 密钥保护状态\n` +
					`环境变量敏感项: ${envCount} 个\n` +
					`.env 文件敏感项: ${fileCount} 个\n` +
					`内置密钥模式: ${SECRET_PATTERNS.length} 条\n` +
					`\n用法: /secret scan | /secret test | /secret refresh`,
				"info",
			);
		},
	});

	// -----------------------------------------------------------------------
	// tool_call 拦截：bash 命令包含敏感值 → 阻止
	// -----------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const leaked = containsSecret(command, allSecrets);

		if (leaked) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`🛡️ 已阻止包含敏感值的命令（来源: ${leaked}）`,
					"warning",
				);
			}
			return {
				block: true,
				reason: `Blocked: command contains secret (${leaked})`,
			};
		}

		return undefined;
	});

	// -----------------------------------------------------------------------
	// tool_result 屏蔽：输出中的敏感值 → ***redacted***
	// -----------------------------------------------------------------------
	pi.on("tool_result", async (event) => {
		if (!event.content || event.content.length === 0) return undefined;

		let modified = false;
		const newContent = event.content.map((block: any) => {
			if (block.type === "text") {
				const redacted = redactText(block.text, allSecrets);
				if (redacted !== block.text) {
					modified = true;
					return { ...block, text: redacted };
				}
			}
			return block;
		});

		if (modified) {
			return { content: newContent };
		}
		return undefined;
	});

	// -----------------------------------------------------------------------
	// user_bash 拦截：用户 ! 命令也检查
	// -----------------------------------------------------------------------
	pi.on("user_bash", async (event, ctx) => {
		const leaked = containsSecret(event.command, allSecrets);
		if (leaked) {
			if (ctx.hasUI) {
				ctx.ui.notify(`🛡️ 命令包含敏感值（来源: ${leaked}），已拦截`, "warning");
			}
			return { block: true, reason: `Blocked: command contains secret (${leaked})` };
		}
		return undefined;
	});
}
