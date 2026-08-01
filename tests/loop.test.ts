/**
 * loop.ts 状态机单元测试
 * 覆盖：契约确认（选择框三路径）、LOOP_DONE 裁判（fail-open/continue/上限）、
 *       暂停/恢复（pendingSend）、settled 续跑、持久化
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "loop-state.json");
const TASKS_FILE = path.join(os.homedir(), ".pi", "agent", "loop-tasks.json");

// 每个测试前清状态文件：防止测试间通过真实文件泄漏状态（前序测试写入的 active=true 会拦截后续启动）
beforeEach(() => {
	try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }
	try { fs.rmSync(TASKS_FILE, { force: true }); } catch { /* ignore */ }
});

async function loadLoop() {
	vi.resetModules(); // 每个测试重新加载模块（隔离模块级状态）
	const mod = await import("../extensions/loop.ts");
	const handlers: Record<string, any> = {};
	const logs: string[] = [];
	const appended: any[] = [];
	const mockPi = {
		registerCommand: (n: string, o: any) => { handlers[n] = o.handler; },
		on: (ev: string, h: any) => { handlers[ev] = h; },
		sendUserMessage: (m: string) => logs.push("[SEND] " + String(m)),
		appendEntry: (t: string, d: any) => { appended.push([t, d]); },
	};
	mod.default(mockPi);
	return { handlers, logs, appended };
}

interface LoopHarness {
	handlers: Record<string, any>;
	logs: string[];
	appended: any[];
	session: any[];
	ctx: any;
	setSelect: (c: string) => void;
}

async function makeHarness(): Promise<LoopHarness> {
	const { handlers, logs, appended } = await loadLoop();
	const session: any[] = [];
	let selectChoice = "✅ 开始执行";
	const ctx = {
		ui: {
			notify: (m: string) => logs.push("[NOTIFY] " + String(m).slice(0, 60)),
			setStatus: () => {}, setWidget: () => {},
			theme: { fg: (c: string, s: string) => s },
			select: async () => { logs.push("[SELECT]"); return selectChoice; },
		},
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getEntries: () => session, getBranch: () => session },
		model: { id: "t" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false }) },
	};
	const harness = {
		handlers, logs, appended, session, ctx,
		setSelect: (c) => { selectChoice = c; },
	};
	activeHarnesses.push(harness);
	return harness;
}

// 每个测试后清理：触发 session_shutdown 杀掉 interval，防止相互干扰
let activeHarnesses: LoopHarness[] = [];
afterEach(async () => {
	for (const h of activeHarnesses) {
		try { await h.handlers["session_shutdown"]({ type: "session_shutdown", reason: "quit" }, h.ctx); } catch { /* ignore */ }
	}
	activeHarnesses = [];
});

describe("loop 契约流程", () => {
	it("模糊目标起草契约后弹选择框，确认后执行", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("模糊目标", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "[CONTRACT] 判据 [/CONTRACT] [CONTRACT_PENDING]" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		expect(h.logs.some(l => l === "[SELECT]")).toBe(true);
		expect(h.logs.some(l => l.includes("契约已确认"))).toBe(true);
		// 500ms 后 followUp 发送
		await new Promise(r => setTimeout(r, 700));
		expect(h.logs.some(l => l.includes("继续完成目标") && l.includes("用户已确认"))).toBe(true);
	});

	it("选择'修改契约'触发重新起草", async () => {
		const h = await makeHarness();
		h.setSelect("📝 修改契约");
		await h.handlers["loop"]("模糊目标", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "[CONTRACT] 判据 [/CONTRACT] [CONTRACT_PENDING]" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		expect(h.logs.some(l => l.includes("重新起草契约"))).toBe(true);
	});

	it("选择'取消'暂停循环", async () => {
		const h = await makeHarness();
		h.setSelect("❌ 取消");
		await h.handlers["loop"]("模糊目标", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "[CONTRACT] 判据 [/CONTRACT] [CONTRACT_PENDING]" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		expect(h.logs.some(l => l.includes("循环已暂停"))).toBe(true);
	});

	it("清晰目标直接执行（无 CONTRACT_PENDING 不暂停）", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("统计文件数", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "完成 [LOOP_CONTINUE]" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		expect(h.logs.some(l => l.includes("契约已起草"))).toBe(false);
	});
});

describe("loop 裁判与续跑", () => {
	it("[LOOP_DONE] + 裁判不可用 → fail-open 完成", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("测试目标", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "完成了 [LOOP_DONE]" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		expect(h.logs.some(l => l.includes("裁判不可用") || l.includes("目标完成"))).toBe(true);
		// 持久化清除
		expect(h.appended.some(([t, d]) => t === "loop-state" && d?.ended)).toBe(true);
	});

	it("[LOOP_CONTINUE] → pendingSend → agent_settled 才发送", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("测试目标", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "进展 [LOOP_CONTINUE]" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		// agent_end 后不应立即发送（settled 才发）
		const sendsAtEnd = h.logs.filter(l => l.startsWith("[SEND]")).length;
		await h.handlers["agent_settled"]({ type: "agent_settled" }, h.ctx);
		const sendsAfter = h.logs.filter(l => l.startsWith("[SEND]")).length;
		expect(sendsAfter).toBeGreaterThan(sendsAtEnd);
	});

	it("暂停后 settled 不发送", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("测试目标", h.ctx);
		await h.handlers["loop"]("pause", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "x [LOOP_CONTINUE]" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		const before = h.logs.filter(l => l.startsWith("[SEND]")).length;
		await h.handlers["agent_settled"]({ type: "agent_settled" }, h.ctx);
		expect(h.logs.filter(l => l.startsWith("[SEND]")).length).toBe(before);
	});

	it("ESC 中止（signal.aborted）→ 暂停", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("测试目标", h.ctx);
		const abortedCtx = { ...h.ctx, signal: { aborted: true } };
		h.session.push({ type: "message", message: { role: "assistant", content: "" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, abortedCtx);
		expect(h.logs.some(l => l.includes("你中止了本轮"))).toBe(true);
	});

	it("空回复（连接错误）→ 重试下一轮而非暂停", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("测试目标", h.ctx);
		h.session.push({ type: "message", message: { role: "assistant", content: "" } });
		await h.handlers["agent_end"]({ type: "agent_end", messages: [] }, h.ctx);
		expect(h.logs.some(l => l.includes("自动重试下一轮"))).toBe(true);
		expect(h.logs.some(l => l.includes("你中止了本轮"))).toBe(false);
		// settled 后应发送下一轮
		await h.handlers["agent_settled"]({ type: "agent_settled" }, h.ctx);
		expect(h.logs.some(l => l.startsWith("[SEND]") && l.includes("继续完成目标"))).toBe(true);
	});
});

describe("loop 持久化", () => {
	it("启动/暂停/停止时 appendEntry 状态同步", async () => {
		const h = await makeHarness();
		await h.handlers["loop"]("持久化测试", h.ctx);
		await new Promise(r => setTimeout(r, 300)); // 等待模块初始化完成（vitest resetModules 时序）
		expect(h.appended.filter(([t]) => t === "loop-state").length).toBeGreaterThan(0);
		const startEntry = h.appended[h.appended.length - 1][1];
		expect(startEntry.goal).toBe("持久化测试");
		expect(startEntry.phase).toBe("executing");
		await h.handlers["loop"]("pause", h.ctx);
		const pausedEntry = h.appended[h.appended.length - 1][1];
		expect(pausedEntry.paused).toBe(true);
		await h.handlers["loop"]("stop", h.ctx);
		expect(h.appended[h.appended.length - 1][1]?.ended).toBe(true);
	});

	it("分支恢复（session_start 读分支 entry）", async () => {
		const h = await makeHarness();
		const branchState = {
			goal: "分支目标", iteration: 3, maxIterations: null,
			active: true, paused: false, startedAt: Date.now(), pausedMs: 0,
			phase: "executing", ts: Date.now(),
		};
		const branchCtx = {
			...h.ctx,
			ui: { ...h.ctx.ui, notify: (m: string) => h.logs.push("[NOTIFY2] " + String(m).slice(0, 60)) },
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [{ type: "custom", customType: "loop-state", data: branchState }],
			},
		};
		await h.handlers["session_start"]({ type: "session_start", reason: "resume" }, branchCtx);
		expect(h.logs.some(l => l.startsWith("[NOTIFY2]") && l.includes("已恢复"))).toBe(true);
	});

	it("分支 ended 标记阻止恢复", async () => {
		const h = await makeHarness();
		const branchCtx = {
			...h.ctx,
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [{ type: "custom", customType: "loop-state", data: { ended: true } }],
			},
		};
		await h.handlers["session_start"]({ type: "session_start", reason: "resume" }, branchCtx);
		expect(h.logs.some(l => l.includes("已恢复"))).toBe(false);
	});
});
