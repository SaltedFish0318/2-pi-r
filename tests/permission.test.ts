/**
 * permission-gate 单元测试
 * 覆盖：asCmd 危险命令匹配（命令位置 vs 参数文本）、PowerShell 模式、拦截行为
 */
import { describe, it, expect, beforeEach } from "vitest";

interface ToolCallHandler {
	(event: { toolName: string; input: { command: string } }, ctx: any): Promise<any>;
}

async function loadPermissionGate() {
	const mod = await import("../extensions/permission-gate.ts");
	const handlers: Record<string, any> = {};
	mod.default({
		registerCommand: () => {},
		on: (ev: string, h: any) => { handlers[ev] = h; },
		events: { emit: () => {}, on: () => {} },
	});
	return handlers["tool_call"] as ToolCallHandler;
}

const noUICtx = { hasUI: false, ui: {} };

describe("permission-gate 危险命令检测", () => {
	let toolCall: ToolCallHandler;
	beforeEach(async () => {
		toolCall = await loadPermissionGate();
	});

	async function check(command: string): Promise<"BLOCKED" | "allow"> {
		const r = await toolCall({ toolName: "bash", input: { command } }, noUICtx);
		return r ? "BLOCKED" : "allow";
	}

	it("拦截真实关机命令", async () => {
		expect(await check("shutdown now")).toBe("BLOCKED");
		expect(await check("sudo shutdown -h")).toBe("BLOCKED");
		expect(await check("ls; shutdown")).toBe("BLOCKED");
		expect(await check("shutdown&echo hi")).toBe("BLOCKED");
	});

	it("不误报 grep/echo 中的关键词", async () => {
		expect(await check('grep "shutdown" file.txt')).toBe("allow");
		expect(await check('echo "shutdown" test')).toBe("allow");
		expect(await check('grep "rm -rf" file')).toBe("allow");
		expect(await check('grep -r "reboot" .')).toBe("allow");
	});

	it("拦截 rm -rf / 递归删除", async () => {
		expect(await check("rm -rf /tmp/x")).toBe("BLOCKED");
		expect(await check("sudo rm -rf /")).toBe("BLOCKED");
	});

	it("拦截 sudo 提权", async () => {
		expect(await check("sudo apt install x")).toBe("BLOCKED");
	});

	it("拦截 PowerShell 危险命令（仅 powershell 开头）", async () => {
		expect(await check('powershell -Command "Remove-Item C:\\temp\\x"')).toBe("BLOCKED");
		expect(await check('powershell -Command "Stop-Computer -Force"')).toBe("BLOCKED");
		expect(await check('powershell -c "Format-Volume -DriveLetter D"')).toBe("BLOCKED");
		expect(await check('powershell -Command "Clear-Content log.txt"')).toBe("BLOCKED");
	});

	it("PowerShell 关键词不出现在 powershell 命令中时不误报", async () => {
		expect(await check("grep Remove-Item file.txt")).toBe("allow");
		expect(await check('echo "Stop-Computer"')).toBe("allow");
		expect(await check("powershell -c \"Get-Process | Select Name\"")).toBe("allow");
	});

	it("放行普通命令", async () => {
		expect(await check("ls -la")).toBe("allow");
		expect(await check("node -e \"console.log(1)\"")).toBe("allow");
		expect(await check("git status")).toBe("allow");
	});

	it("拦截 git 危险操作", async () => {
		expect(await check("git push --force origin main")).toBe("BLOCKED");
		expect(await check("git reset --hard HEAD~1")).toBe("BLOCKED");
	});
});
