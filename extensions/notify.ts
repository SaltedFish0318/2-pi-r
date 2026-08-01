/**
 * Pi Notify Extension
 *
 * Sends a native terminal notification when Pi agent is done and waiting for input.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 *
 * 增强：
 * - 循环模式（loop 扩展）活跃时静默，避免每轮弹通知
 * - 监听 permission:ask 事件：权限确认等待时发系统通知提醒
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	// 单引号转义：PowerShell 字符串内 '' 表示一个字面单引号
	const esc = (s: string) => s.replace(/'/g, "''");
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${esc(body)}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${esc(title)}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("child_process");
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
	} else {
		notifyOSC777(title, body);
	}
}

// =========================================================================
// 循环活跃检测（loop 扩展会维护此文件；active=true 表示循环运行中）
// =========================================================================

const LOOP_STATE_FILE = join(homedir(), ".pi", "agent", "loop-state.json");
const MIN_NOTIFY_INTERVAL_MS = 60_000;

function isLoopActive(): boolean {
	try {
		if (!existsSync(LOOP_STATE_FILE)) return false;
		const d = JSON.parse(readFileSync(LOOP_STATE_FILE, "utf8"));
		return !!d.active && !d.paused;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	let lastNotifyAt = 0;

	pi.on("agent_end", async () => {
		// 循环运行中：每轮结束不弹（等整个循环结束，文件删除后恢复通知）
		if (isLoopActive()) return;
		// 频率限制：60 秒内不重复弹
		const now = Date.now();
		if (now - lastNotifyAt < MIN_NOTIFY_INTERVAL_MS) return;
		lastNotifyAt = now;
		notify("Pi", "Ready for input");
	});

	// permission 扩展弹确认框时 → 系统通知提醒（用户可能没盯着屏幕）
	pi.events.on("permission:ask", (data: unknown) => {
		const d = (data ?? {}) as { title?: string; detail?: string };
		const title = d.title ?? "权限确认";
		const detail = (d.detail ?? "").replace(/\s+/g, " ").slice(0, 80);
		lastNotifyAt = Date.now();
		notify(title, `需要你的决定：${detail}`);
	});
}
