/**
 * Computer-Use 状态指示器扩展
 *
 * 当 pi-computer-use 执行桌面/浏览器操作时，在屏幕右下角显示置顶状态窗，
 * 让你在操作其他应用时也能看到当前执行状态。
 *
 * 用法：
 *   /cu-status              — 查看状态（开/关、显示中）
 *   /cu-status on|off       — 启用/禁用状态窗
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const EXT_DIR = fileURLToPath(new URL(".", import.meta.url));
const STATUS_FILE = join(homedir(), ".pi", "agent", "computer-use-status.txt");
const WINDOW_SCRIPT = join(EXT_DIR, "..", "scripts", "status-window.ps1");

// computer-use 的工具名 → 显示标签（纯文字，WinForms 字体不支持 emoji）
const CU_TOOLS: Record<string, string> = {
	find_roots: "查找窗口",
	observe_ui: "观察界面",
	search_ui: "搜索界面",
	expand_ui: "展开界面",
	inspect_ui: "检查控件",
	act_ui: "执行操作",
	read_text: "读取文本",
	wait_for: "等待条件",
	launch_browser: "启动浏览器",
	navigate_browser: "页面导航",
	evaluate_browser: "浏览器执行",
};

// 从工具参数生成简短摘要
function summarize(tool: string, args: any): string {
	switch (tool) {
		case "find_roots":
			return args.text ? `「${String(args.text).slice(0, 24)}」` : args.app ? `app=${args.app}` : "";
		case "observe_ui":
			return args.root ? `${args.root}${args.mode ? ` (${args.mode})` : ""}` : "";
		case "act_ui": {
			const acts: string[] = (args.actions ?? []).map((a: any) => {
				if (a.action === "click") return a.ref ? `点 ${a.ref}` : `点(${a.x},${a.y})`;
				if (a.action === "press") return `按 ${a.ref}`;
				if (a.action === "setText") return `输入→${a.ref}`;
				if (a.action === "typeText") return `键入 "${String(a.text ?? "").slice(0, 12)}"`;
				if (a.action === "keypress") return `按键 ${(a.keys ?? []).join("+")}`;
				if (a.action === "scroll") return `滚动 ${a.scrollY ?? a.scrollX ?? ""}`;
				return a.action;
			});
			return acts.join(" | ") || "";
		}
		case "launch_browser":
		case "navigate_browser":
			return args.url ? args.url.replace(/^https?:\/\//, "").slice(0, 40) : "";
		case "wait_for":
			return args.text ? `「${String(args.text).slice(0, 20)}」` : args.role ? `role=${args.role}` : "";
		case "evaluate_browser":
			return (args.expression ?? "").slice(0, 24);
		case "search_ui":
			return args.text ? `「${String(args.text).slice(0, 20)}」` : "";
		default:
			return "";
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let windowStarted = false;
	let agentActive = false;
	let lastAction = "";

	function ensureWindow() {
		if (windowStarted) return;
		windowStarted = true;
		try {
			// 后台启动置顶状态窗
			const child = execFile(
				"powershell",
				["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", WINDOW_SCRIPT],
				{ windowsHide: true },
			);
			child.on("error", () => { windowStarted = false; });
			// 进程退出（如右击关闭窗口）→ 允许下次操作重新启动
			child.on("exit", () => { windowStarted = false; });
		} catch {
			windowStarted = false;
		}
	}

	function setStatus(text: string) {
		if (!enabled) return;
		try {
			writeFileSync(STATUS_FILE, text, "utf-8");
		} catch {
			/* ignore */
		}
	}

	function clearStatus() {
		try {
			writeFileSync(STATUS_FILE, "", "utf-8");
		} catch {
			/* ignore */
		}
	}

	// 回合边界：agent 开始 → 标记活跃（不立即显示，等第一个 computer-use 工具）
	pi.on("agent_start", () => {
		agentActive = true;
	});

	// 回合边界：agent 结束 → 隐藏窗口
	pi.on("agent_end", () => {
		agentActive = false;
		lastAction = "";
		clearStatus();
	});
	pi.on("agent_settled", () => {
		agentActive = false;
		lastAction = "";
		clearStatus();
	});

	// 工具执行：更新具体动作（回合内持续显示，不闪）
	pi.on("tool_execution_start", (event) => {
		const label = CU_TOOLS[event.toolName];
		if (!label) return;
		if (!agentActive) agentActive = true;
		ensureWindow();
		const detail = summarize(event.toolName, event.args ?? {});
		lastAction = `[pi] ${label}${detail ? ` ${detail}` : ""}…`;
		setStatus(lastAction);
	});

	// 工具结束：保留状态（不隐藏，等 agent_end）
	pi.on("tool_execution_end", (event) => {
		if (!CU_TOOLS[event.toolName]) return;
		if (lastAction) {
			setStatus(lastAction.replace(/…$/, " ✓"));
		}
	});

	pi.registerCommand("cu-status", {
		description: "computer-use 状态窗：/cu-status [on|off]",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (input === "on") {
				enabled = true;
				ensureWindow();
				ctx.ui.notify("✅ 状态窗已启用", "success");
			} else if (input === "off") {
				enabled = false;
				clearStatus();
				ctx.ui.notify("状态窗已禁用", "info");
			} else {
				ctx.ui.notify(
					`状态窗: ${enabled ? "启用" : "禁用"}${windowStarted ? "（窗口进程已启动）" : "（窗口未启动）"}\n用法: /cu-status on|off`,
					"info",
				);
			}
		},
	});
}
