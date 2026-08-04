/**
 * OpenCode Go 订阅额度显示扩展
 *
 * 在 pi footer 显示 OpenCode Go 订阅的滚动/每周/每月用量。
 *
 * 用法:
 *   /opencode-quota            — 查看当前额度 + 状态
 *   /opencode-quota refresh    — 立即刷新
 *   /opencode-quota login      — 独立窗口登录（不影响正在使用的浏览器），自动导出登录态
 *   /opencode-quota cookie <cookies> — 手动粘贴 cookie（兜底，F12 → Application → Cookies 复制）
 *   /opencode-quota workspace <id> — 设置 workspace ID
 *   /opencode-quota clear      — 清除登录态
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const EXT_DIR = fileURLToPath(new URL(".", import.meta.url));

const execFileAsync = promisify(execFile);

// =========================================================================
// 配置
// =========================================================================

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "opencode-quota.json");
const COOKIE_PATH = join(AGENT_DIR, "opencode-cookies.txt");

interface Config {
	workspaceId: string;
	cookiePath: string;
	refreshMinutes: number;
}

const DEFAULT_CONFIG: Config = {
	workspaceId: "wrk_01KETMHCSYN3KEWXR8MMCASH5Y",
	cookiePath: COOKIE_PATH,
	refreshMinutes: 15,
};

function loadConfig(): Config {
	try {
		return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(cfg: Config) {
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// =========================================================================
// 数据获取
// =========================================================================

interface QuotaData {
	rolling: number | null;
	weekly: number | null;
	monthly: number | null;
	rollingReset: string | null;
	weeklyReset: string | null;
	monthlyReset: string | null;
	fetchedAt: number | null;
	error?: string;
}

async function fetchQuota(cfg: Config): Promise<QuotaData> {
	const base: QuotaData = { rolling: null, weekly: null, monthly: null, rollingReset: null, weeklyReset: null, monthlyReset: null, fetchedAt: null };
	if (!existsSync(cfg.cookiePath)) {
		return { ...base, error: "未登录：请运行 /opencode-quota login" };
	}
	const cookie = readFileSync(cfg.cookiePath, "utf-8").trim();
	if (!cookie) return { ...base, error: "cookie 为空：请运行 /opencode-quota login" };

	try {
		const r = await fetch(`https://opencode.ai/workspace/${cfg.workspaceId}/go`, {
			headers: {
				Cookie: cookie,
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
				"Accept-Language": "zh-CN,zh;q=0.9",
			},
			signal: AbortSignal.timeout(15000),
		});
		if (r.status === 401 || r.status === 403) {
			return { ...base, error: `登录已过期 (${r.status})：请运行 /opencode-quota login` };
		}
		const html = await r.text();
		const q = parseQuota(html);
		if (!q) return { ...base, error: "无法解析页面数据（页面结构可能变化）" };
		return { ...q, fetchedAt: Date.now() };
	} catch (e: any) {
		return { ...base, error: `请求失败: ${e?.message ?? e}` };
	}
}

function parseQuota(html: string): Omit<QuotaData, "fetchedAt" | "error"> | null {
	// 按 usage-item 块切分，每块含 label / value / reset-time
	const items = html.split('data-slot="usage-item"').slice(1);
	if (items.length === 0) return null;

	const out: Omit<QuotaData, "fetchedAt" | "error"> = {
		rolling: null, weekly: null, monthly: null,
		rollingReset: null, weeklyReset: null, monthlyReset: null,
	};
	let found = false;

	for (const item of items) {
		const labelM = item.match(/usage-label"[^>]*>([^<]+)</);
		if (!labelM) continue;
		const label = labelM[1].trim();
		const valueM = item.match(/usage-value"[^>]*>[\s\S]{0,40}?(\d+)/);
		const resetM = item.match(/reset-time"[^>]*>([\s\S]{0,150}?)<\/span>/);
		if (!valueM) continue;
		const value = parseInt(valueM[1]);
		const reset = resetM
			? resetM[1].replace(/<!--\/?\$?-->/g, "").replace(/\s+/g, " ").trim()
			: null;

		if (/滚动用量|Rolling Usage/i.test(label)) {
			out.rolling = value; out.rollingReset = reset; found = true;
		} else if (/每周用量|Weekly Usage/i.test(label)) {
			out.weekly = value; out.weeklyReset = reset; found = true;
		} else if (/每月用量|Monthly Usage/i.test(label)) {
			out.monthly = value; out.monthlyReset = reset; found = true;
		}
	}
	return found ? out : null;
}

// =========================================================================
// 登录态导出（扫描 Chrome/Edge 的 CDP 端口）
// =========================================================================

async function findCdpPorts(): Promise<Array<{ port: number; isEdge: boolean }>> {
	const ports: Array<{ port: number; isEdge: boolean }> = [];
	const seen = new Set<number>();
	function push(port: number, isEdge: boolean) {
		if (!seen.has(port)) {
			seen.add(port);
			ports.push({ port, isEdge });
		}
	}
	if (process.platform === "win32") {
		try {
			// PowerShell 查 chrome.exe / msedge.exe 带 --remote-debugging-port 的进程
			const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port' } | ForEach-Object { $_.Name + ' ' + [regex]::Match($_.CommandLine, 'remote-debugging-port=(\\d+)').Groups[1].Value }`;
			const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], { timeout: 15000 });
			for (const line of stdout.split(/\r?\n/)) {
				const m = line.trim().match(/^(chrome|msedge)\.exe (\d+)$/);
				if (m) push(parseInt(m[2]), m[1] === "msedge.exe");
			}
		} catch {
			/* ignore */
		}
	} else {
		// Linux/macOS: ps 扫描 chrome/chromium/google-chrome/edge 进程的 --remote-debugging-port
		try {
			const { stdout } = await execFileAsync("ps", ["-eo", "comm,args"], { timeout: 8000 });
			for (const line of stdout.split(/\r?\n/)) {
				const m = line.match(/^(\S+)\s+.*remote-debugging-port=(\d+)/);
				if (!m) continue;
				const comm = m[1].toLowerCase();
				if (/(chrome|chromium|edge)/.test(comm)) {
					push(parseInt(m[2]), /edge/.test(comm));
				}
			}
		} catch {
			/* ignore */
		}
	}
	return ports;
}

async function exportCookiesViaCdp(port: number): Promise<string> {
	// 找到 opencode.ai 的页面 target
	const pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json() as any[];
	const page = pages.find((t: any) => t.type === "page" && t.url.includes("opencode.ai"));
	if (!page) return "";

	// ws 库动态加载（扩展目录依赖）
	const wsPath = join(EXT_DIR, "..", "node_modules", "ws");
	const WebSocket = require(wsPath);

	return await new Promise((resolve, reject) => {
		const ws = new WebSocket(page.webSocketDebuggerUrl);
		const timeout = setTimeout(() => { ws.close(); reject(new Error("CDP timeout")); }, 15000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));
		});
		ws.on("message", (data: any) => {
			const msg = JSON.parse(data.toString());
			if (msg.id === 1) {
				clearTimeout(timeout);
				ws.close();
				const cookies = (msg.result?.cookies ?? []).filter((c: any) => c.domain.includes("opencode.ai"));
				resolve(cookies.map((c: any) => `${c.name}=${c.value}`).join("; "));
			}
		});
		ws.on("error", (e: any) => { clearTimeout(timeout); reject(e); });
	});
}

/**
 * 独立窗口登录：启动一个独立的浏览器实例（独立 profile + 随机端口），
 * 不影响用户正在使用的浏览器。登录后自动导出 cookie 并关闭。
 */

async function findBrowserBinary(): Promise<string | null> {
	const candidates =
		process.platform === "win32"
			? ["msedge", "chrome", "chrome.exe", "msedge.exe"]
			: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "microsoftedge"];
	for (const name of candidates) {
		try {
			const { stdout } = await execFileAsync("which", [name], { timeout: 3000 });
			const p = stdout.trim().split(/\r?\n/)[0];
			if (p && existsSync(p)) return p;
		} catch { /* next */ }
	}
	return null;
}

function getFreePort(): Promise<number> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as { port: number }).port;
			srv.close(() => resolve(port));
		});
	});
}

function killBrowserTreeByProfile(profileDir: string): void {
	try {
		if (process.platform === "win32") {
			execFile(
				"powershell",
				["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${profileDir}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
				() => {},
			);
		} else {
			execFile("pkill", ["-f", profileDir], () => {});
		}
	} catch { /* ignore */ }
}

async function loginViaDedicatedWindow(): Promise<string | null> {
	const browser = await findBrowserBinary();
	if (!browser) return null;

	const port = await getFreePort();
	const profileDir = mkdtempSync(join(tmpdir(), "opencode-quota-"));

	const proc = spawn(
		browser,
		[
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"https://opencode.ai",
		],
		{ detached: true, stdio: "ignore" },
	);
	proc.unref();

	const deadline = Date.now() + 5 * 60 * 1000; // 5 分钟超时
	try {
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2000));
			if (proc.exitCode !== null) break; // 浏览器窗口被用户关闭
			try {
				const exported = await exportCookiesViaCdp(port);
				// 必须出现 auth cookie 才算登录成功（未登录时也会有 oc_locale 等访客 cookie）
				if (exported && /(^|;\s*)auth=/.test(exported)) return exported;
			} catch { /* 浏览器尚未就绪 */ }
		}
	} finally {
		killBrowserTreeByProfile(profileDir);
		setTimeout(() => rmSync(profileDir, { recursive: true, force: true }), 2000);
	}
	return null;
}

// =========================================================================
// 内置 footer 复刻（token 统计）+ 额度追加
// =========================================================================

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

interface Totals {
	input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
}

function usageTotalsFor(entries: any[]): { totals: Totals; latestCacheHitRate?: number } {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const u = entry.message.usage;
			totals.input += u.input; totals.output += u.output;
			totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite;
			totals.cost += u.cost.total;
			const latestPromptTokens = u.input + u.cacheRead + u.cacheWrite;
			latestCacheHitRate = latestPromptTokens > 0 ? (u.cacheRead / latestPromptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			const u = entry.message.usage;
			totals.input += u.input; totals.output += u.output;
			totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite;
			totals.cost += u.cost.total;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			const u = entry.usage;
			totals.input += u.input; totals.output += u.output;
			totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite;
			totals.cost += u.cost.total;
		}
	}
	return { totals, latestCacheHitRate };
}

function quotaStr(q: QuotaData): string | null {
	if (!q.fetchedAt) return null;
	const parts = [
		q.rolling !== null ? `5h${q.rolling}%` : null,
		q.weekly !== null ? `周${q.weekly}%` : null,
		q.monthly !== null ? `月${q.monthly}%` : null,
	].filter(Boolean);
	return parts.length ? `⛽ ${parts.join(" ")}` : null;
}

// =========================================================================
// totals 缓存（footer 渲染频繁，避免每次全量遍历会话）
// =========================================================================

let totalsCache: { key: string; totals: Totals; latestCacheHitRate?: number } | null = null;

/** 带缓存的用量统计：entries 数量或最后一条消息变化时才重算 */
function getUsageTotals(entries: any[]): { totals: Totals; latestCacheHitRate?: number } {
	const last = entries[entries.length - 1];
	const key = `${entries.length}:${last?.id ?? ""}`;
	if (totalsCache && totalsCache.key === key) {
		return { totals: totalsCache.totals, latestCacheHitRate: totalsCache.latestCacheHitRate };
	}
	const result = usageTotalsFor(entries);
	totalsCache = { key, totals: result.totals, latestCacheHitRate: result.latestCacheHitRate };
	return result;
}

function installFooter(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		requestRender = () => tui.requestRender();
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: () => { unsub(); requestRender = undefined; },
			invalidate() {},
			render(width: number): string[] {
				const { totals, latestCacheHitRate } = getUsageTotals(ctx.sessionManager.getEntries());
				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextPercent = contextUsage?.percent ?? 0;

				const parts: string[] = [];
				if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
				if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
				if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
				if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
				if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
					parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);

				const contextPercentStr =
					contextPercent === null || contextPercent === undefined
						? `?/${formatTokens(contextWindow)} (auto)`
						: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
				if (contextPercent > 90) parts.push(theme.fg("error", contextPercentStr));
				else if (contextPercent > 70) parts.push(theme.fg("warning", contextPercentStr));
				else parts.push(contextPercentStr);

				// 追加 OpenCode Go 额度
				const q = quotaStr(quota);
				if (q) parts.push(theme.fg("success", q));
				else if (quota.error) parts.push(theme.fg("dim", `⛽ ${quota.error}`));

				const left = parts.join(" ");
				const modelName = ctx.model?.id || "no-model";
				let right = modelName;
				if (ctx.model?.reasoning) {
					const level = ctx.thinkingLevel || "off";
					right = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
				}
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return [truncateToWidth(left + pad + right, width)];
			},
		};
	});
}

// =========================================================================
// 扩展入口
// =========================================================================

// 模块级状态（installFooter 的渲染闭包引用它们）
let cfg: Config = loadConfig();
let quota: QuotaData = { rolling: null, weekly: null, monthly: null, rollingReset: null, weeklyReset: null, monthlyReset: null, fetchedAt: null };
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let requestRender: (() => void) | undefined;

export default function (pi: ExtensionAPI) {
	function updateStatus() {
		// footer 由 setFooter 渲染，这里只需要触发重绘
		requestRender?.();
	}

	async function refresh() {
		quota = await fetchQuota(cfg);
		requestRender?.();
		return quota;
	}

	// 启动时安装 footer + 拉取一次
	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
		await refresh();
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => { refresh().catch(() => {}); }, cfg.refreshMinutes * 60_000);
	});

	pi.on("session_shutdown", () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	});

	// /opencode-quota 命令
	pi.registerCommand("opencode-quota", {
		description: "OpenCode Go 订阅额度：/opencode-quota [refresh|login|cookie <cookies>|clear|workspace <id>]",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();

			// cookie 命令需要保留整段 cookie（含空格），单独解析
			if (input.startsWith("cookie ")) {
				const cookies = input.slice("cookie ".length).trim().replace(/^["']|["']$/g, "");
				if (!cookies) {
					ctx.ui.notify("用法: /opencode-quota cookie \"name=value; name2=value2\"", "info");
					return;
				}
				writeFileSync(cfg.cookiePath, cookies, "utf-8");
				await refresh();
				if (quota.fetchedAt) {
					ctx.ui.notify("✅ cookie 已保存，额度已刷新", "success");
				} else {
					ctx.ui.notify(`⚠️ cookie 已保存但刷新失败: ${quota.error ?? ""}`, "warning");
				}
				return;
			}

			const [cmd, param] = input.split(/\s+/, 2);

			switch (cmd) {
				case "login": {
					// 方式 1:用户已有带调试端口的浏览器 → 直接导出（兼容旧用法）
					const ports = await findCdpPorts();
					if (ports.length > 0) {
						let exported = "";
						let usedPort = 0;
						for (const { port } of ports) {
							try {
								const c = await exportCookiesViaCdp(port);
								// 未登录时也可能有访客 cookie，必须含 auth 才算有效
								if (c && /(^|;\s*)auth=/.test(c)) { exported = c; usedPort = port; break; }
							} catch { /* try next */ }
						}
						if (!exported) {
							ctx.ui.notify("❌ 找到了浏览器但未导出 cookie：请先在浏览器中打开 opencode.ai 并登录。", "error");
							return;
						}
						writeFileSync(cfg.cookiePath, exported, "utf-8");
						await refresh();
						ctx.ui.notify(`✅ 登录态已保存（来自端口 ${usedPort}），额度已刷新`, "success");
						return;
					}

					// 方式 2:独立窗口登录（不影响正在使用的浏览器）
					ctx.ui.notify("🪟 正在打开独立登录窗口（不影响你的浏览器），请在弹出的窗口登录 opencode.ai（可能需 GitHub 授权）...", "info");
					const exported = await loginViaDedicatedWindow();
					if (!exported) {
						ctx.ui.notify(
							"❌ 独立登录窗口超时或失败。\n可手动兜底：在浏览器 F12 → Application → Cookies 复制 opencode.ai 的 cookie，然后运行 /opencode-quota cookie \"<cookies>\"",
						"error",
					);
						return;
					}
					writeFileSync(cfg.cookiePath, exported, "utf-8");
					await refresh();
					ctx.ui.notify("✅ 登录态已保存（独立窗口方式），额度已刷新", "success");
					return;
				}

				case "refresh": {
					await refresh();
					if (quota.fetchedAt) {
						ctx.ui.notify(
							`⛽ 滚动 ${quota.rolling}% (${quota.rollingReset}) | 周 ${quota.weekly}% (${quota.weeklyReset}) | 月 ${quota.monthly}% (${quota.monthlyReset})`,
							"success",
						);
					} else {
						ctx.ui.notify(`⛽ ${quota.error ?? "暂无数据"}`, "error");
					}
					return;
				}

				case "clear": {
					if (existsSync(cfg.cookiePath)) {
						writeFileSync(cfg.cookiePath, "", "utf-8");
					}
					quota = { rolling: null, weekly: null, monthly: null, rollingReset: null, weeklyReset: null, monthlyReset: null, fetchedAt: null };
					requestRender?.();
					ctx.ui.notify("🧹 登录态已清除", "info");
					return;
				}

				case "workspace": {
					if (param?.startsWith("wrk_")) {
						cfg.workspaceId = param;
						saveConfig(cfg);
						await refresh();
						ctx.ui.notify(`✅ workspace 已设置为 ${param}`, "success");
					} else {
						ctx.ui.notify(`当前 workspace: ${cfg.workspaceId}\n用法: /opencode-quota workspace wrk_xxx`, "info");
					}
					return;
				}

				default: {
					const status = quota.fetchedAt
						? `⛽ 滚动 ${quota.rolling}% (${quota.rollingReset})\n   周 ${quota.weekly}% (${quota.weeklyReset})\n   月 ${quota.monthly}% (${quota.monthlyReset})\n   更新于 ${new Date(quota.fetchedAt).toLocaleTimeString()}`
						: `⛽ ${quota.error ?? "暂无数据"}`;
					ctx.ui.notify(
						`${status}\n\n用法: /opencode-quota refresh | login | clear | workspace <id>`,
						"info",
					);
					return;
				}
			}
		},
	});
}
