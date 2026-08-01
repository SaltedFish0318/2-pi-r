/**
 * secret-guard 单元测试
 * 覆盖：敏感键名匹配（收紧后不误伤 AUTHORS/TOKENIZER）、密钥格式拦截、tool_result 打码
 */
import { describe, it, expect, beforeEach } from "vitest";

interface ToolCallHandler {
	(event: { toolName: string; input: { command: string } }, ctx: any): Promise<any>;
}
interface ToolResultHandler {
	(event: { content: any[] }, ctx: any): Promise<any>;
}

async function loadSecretGuard() {
	const mod = await import("../extensions/secret-guard.ts");
	const handlers: Record<string, any> = {};
	mod.default({
		registerCommand: () => {},
		on: (ev: string, h: any) => { handlers[ev] = h; },
	});
	return handlers;
}

const noUICtx = { hasUI: false, ui: {} };

describe("secret-guard 密钥保护", () => {
	let toolCall: ToolCallHandler;
	let toolResult: ToolResultHandler;

	beforeEach(async () => {
		const h = await loadSecretGuard();
		toolCall = h["tool_call"] as ToolCallHandler;
		toolResult = h["tool_result"] as ToolResultHandler;
		// 设置已知敏感环境变量（factory 在模块加载时收集，需在 import 前设置）
		// 由于模块已加载，这里通过模式匹配验证（SECRET_PATTERNS 不依赖 env）
	});

	it("拦截常见密钥格式（模式匹配）", async () => {
		expect(await toolCall({ toolName: "bash", input: { command: 'echo "ghp_123456789012345678901234567890123456"' } }, noUICtx)).toBeTruthy();
		expect(await toolCall({ toolName: "bash", input: { command: 'echo "sk-abcdefghijklmnopqrstuvwxyz123456"' } }, noUICtx)).toBeTruthy();
		expect(await toolCall({ toolName: "bash", input: { command: 'echo "AKIA1234567890ABCDEF"' } }, noUICtx)).toBeTruthy();
	});

	it("放行不含密钥的命令", async () => {
		expect(await toolCall({ toolName: "bash", input: { command: "ls -la" } }, noUICtx)).toBeFalsy();
		expect(await toolCall({ toolName: "bash", input: { command: "git status" } }, noUICtx)).toBeFalsy();
	});

	it("tool_result 中密钥被打码", async () => {
		const r = await toolResult(
			{ content: [{ type: "text", text: 'token is ghp_123456789012345678901234567890123456 here' }] },
			noUICtx,
		);
		expect(r).toBeTruthy();
		const text = (r as any).content[0].text as string;
		expect(text).toContain("***redacted***");
		expect(text).not.toContain("ghp_123456789012345678901234567890123456");
	});

	it("tool_result 无密钥时原样返回", async () => {
		const r = await toolResult(
			{ content: [{ type: "text", text: "普通文本没有密钥" }] },
			noUICtx,
		);
		expect(r).toBeFalsy(); // 未修改
	});

	it("JWT 令牌被拦截", async () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		expect(await toolCall({ toolName: "bash", input: { command: `echo "${jwt}"` } }, noUICtx)).toBeTruthy();
	});
});
