/**
 * Loop Mode Extension v4
 *
 * Continuously iterates on a goal until completion, similar to
 * Claude Code's /loop and Codex's goal mode.
 *
 * 持久化：目标在完成或主动停止前保持持久，/reload 或重启 pi 后自动恢复。
 *   - 运行中 → 恢复后自动续跑
 *   - 暂停中 → 恢复暂停面板，/loop resume 继续
 *
 * Usage:
 *   /loop <goal>           — Start loop（如：/loop 帮我学英语）
 *   /loop max=100 <goal>   — 自定义最大轮数
 *   /loop stop             — 停止并清除循环
 *   /loop pause            — 暂停循环（保留进度）
 *   /loop resume           — 恢复暂停的循环
 *   /loop status           — 查看当前进度
 *
 * AI 回复末尾用 [LOOP_CONTINUE] 表示需要继续，
 * 用 [LOOP_DONE] 表示目标已完成。
 * 按 Escape 可随时中止（暂停）。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// =========================================================================
// 持久化：状态写入 ~/.pi/agent/，重启/reload 后自动恢复
// =========================================================================

const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "loop-state.json");
const TASKS_FILE = path.join(os.homedir(), ".pi", "agent", "loop-tasks.json");
const EXT_DIR_LOOP = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));

/** 保存循环状态（null 表示已结束/停止，删除文件） */
function persistState(s: LoopState | null): void {
	try {
		if (!s) {
			fs.rmSync(STATE_FILE, { force: true });
			// 分支持久化：ended 标记，防止旧分支恢复已停止的循环
			piRef?.appendEntry("loop-state", { ended: true, ts: Date.now() });
			return;
		}
		const out = {
			goal: s.goal,
			title: s.title,
			iteration: s.iteration,
			maxIterations: isFinite(s.maxIterations) ? s.maxIterations : null, // JSON 不支持 Infinity
			active: s.active,
			paused: s.paused,
			startedAt: s.startedAt,
			pausedMs: s.pausedMs ?? 0,
			pausedAt: s.pausedAt ?? null,
			phase: s.phase ?? "executing",
		};
		fs.writeFileSync(STATE_FILE, JSON.stringify(out));
		// 分支持久化（pi 原生：跟随 fork/树导航/压缩），与文件双写
		piRef?.appendEntry("loop-state", { ...out, ts: Date.now() });
	} catch (err) {
		debugLog("persistState 失败: " + (err as Error).message + " @ " + STATE_FILE);
	}
}

/** 从当前分支恢复状态（pi 原生方式，分支内最后一条有效 entry） */
function loadStateFromBranch(ctx: ExtensionContext): LoopState | null {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === "loop-state") {
				const d = e.data as Record<string, unknown> | null | undefined;
				if (!d) continue;
				if (d.ended) return null; // 该分支循环已结束
				if (typeof d.goal === "string" && d.goal) {
					return {
						goal: d.goal,
						iteration: (d.iteration as number) ?? 1,
						maxIterations: d.maxIterations === null ? Infinity : ((d.maxIterations as number) ?? Infinity),
						active: !!d.active,
						paused: !!d.paused,
						startedAt: (d.startedAt as number) ?? Date.now(),
						pausedMs: (d.pausedMs as number) ?? 0,
						pausedAt: (d.pausedAt as number | null) ?? undefined,
						phase: (d.phase as "contract" | "executing") ?? "executing",
					};
				}
			}
		}
	} catch (err) {
		debugLog("loadStateFromBranch 失败: " + (err as Error).message);
	}
	return null;
}

/** 从磁盘恢复循环状态（未完成未停止时返回，否则 null） */
function loadStateFromDisk(): LoopState | null {
	try {
		const raw = fs.readFileSync(STATE_FILE, "utf-8");
		const d = JSON.parse(raw);
		if (!d || typeof d.goal !== "string" || !d.goal) return null;
		if (!d.active && !d.paused) return null; // 已结束/停止的循环不恢复
		return {
			goal: d.goal,
			iteration: d.iteration ?? 1,
			maxIterations: d.maxIterations === null ? Infinity : (d.maxIterations ?? Infinity),
			active: !!d.active,
			paused: !!d.paused,
			startedAt: d.startedAt ?? Date.now(),
			pausedMs: d.pausedMs ?? 0,
			pausedAt: d.pausedAt ?? undefined,
			phase: (d.phase as "contract" | "executing") ?? "executing",
		};
	} catch (err) {
		// 预期：文件不存在（无循环）；意外：JSON 损坏等 → 记录日志
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			debugLog("loadStateFromDisk 读取异常: " + (err as Error).message);
		}
		return null;
	}
}

/** 保存自动任务列表 */
function persistTasks(tasks: AutoTask[]): void {
	try {
		fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks));
	} catch {
		// 忽略
	}
}

/** 从磁盘恢复自动任务列表 */
function loadTasksFromDisk(): AutoTask[] {
	try {
		const raw = fs.readFileSync(TASKS_FILE, "utf-8");
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

// =========================================================================
// 调试日志（写入文件，reload 后可用于排查事件是否触发）
// =========================================================================
const LOG_FILE = path.join(os.homedir(), ".pi", "agent", "loop-debug.log");
let logSizeChecked = false;
function debugLog(msg: string): void {
	try {
		if (!logSizeChecked) {
			logSizeChecked = true;
			// 每次模块加载只截断一次：文件超过 200KB 时保留最后 200 行（防止无限循环日志膨胀）
			const stat = fs.statSync(LOG_FILE);
			if (stat.size > 200_000) {
				const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(-200);
				fs.writeFileSync(LOG_FILE, lines.join("\n") + "\n");
			}
		}
		fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// 忽略日志写入失败
	}
	console.log("[loop] " + msg);
}

// =========================================================================
// 跨模块实例通信标记（reload 后新模块读取旧模块设置的标志）
// =========================================================================

declare global {
	var __loopStaleUI: boolean | undefined;
}

function getStaleFlag(): boolean {
	return globalThis.__loopStaleUI === true;
}
function setStaleFlag(v: boolean): void {
	globalThis.__loopStaleUI = v;
}

// =========================================================================
// 状态定义
// =========================================================================

interface LoopState {
	goal: string;
	title?: string; // LLM 提取的短标题（widget 显示用），提取失败时回退到截断目标
	iteration: number;
	maxIterations: number;
	active: boolean;
	paused: boolean;
	startedAt: number; // 循环开始时间戳（ms），用于显示已运行时长
	pausedAt?: number; // 进入暂停的时间戳，暂停期间时间冻结
	pausedMs: number; // 累计暂停时长（ms），resume 时累加
	phase?: "contract" | "executing"; // contract=起草契约待确认；executing=执行中
}

/**
 * 自动触发任务：到时间自动启动循环，无需手动 /loop。
 */
interface AutoTask {
	id: string;
	kind: "time";
	goal: string;
	maxIterations: number;
	description: string;
	delayMs?: number; // 一次性：N 毫秒后触发
	createdAt: number;
	dailyTime?: string; // 每日："HH:MM" 触发
	lastFiredDay?: string; // 每日任务当天已触发标记 "YYYY-MM-DD"
	fired: boolean;
}

const DEFAULT_MAX_ITERATIONS = Infinity; // 默认无限循环，除非显式 max=N

/** 轮次上限显示：有限时 "50"，无限时 "∞" */
function maxLabel(m: number): string {
	return isFinite(m) ? String(m) : "∞";
}

/** 截断长目标文本（status 30 字符 / widget 40 字符） */
function truncateGoal(s: string, limit: number): string {
	return s.length > limit ? s.substring(0, limit - 1) + "…" : s;
}

/**
 * 用 LLM 把长目标提取为短标题（类似 pi 自动生成 session 标题）。
 * 失败时返回 undefined（调用方回退到截断目标）。
 */
async function summarizeGoal(ctx: ExtensionContext, goal: string): Promise<string | undefined> {
	try {
		if (!ctx.model) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return undefined;
		const userMessage: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `为下面的任务目标生成一个简洁标题（≤24 字，中文，概括要做什么即可，不要引号）：\n\n${goal.slice(0, 2000)}`,
				},
			],
			timestamp: Date.now(),
		};
		const resp = await complete(
			ctx.model,
			{
				systemPrompt: "你是标题生成器。只输出标题本身，不要任何解释、引号或前后缀。",
				messages: [userMessage],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: AbortSignal.timeout(15_000) },
		);
		const text = resp.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim()
			.replace(/^["'“”«»「『]+|["'“”«»」』]+$/g, "")
			.replace(/\s+/g, " ")
			.slice(0, 40);
		if (!text) return undefined;
		debugLog("目标标题: " + text);
		return text;
	} catch (err) {
		debugLog("目标标题提取失败: " + (err as Error).message);
		return undefined;
	}
}

/** 已运行时长：扣除累计暂停时间；暂停期间冻结不再增长 */
function elapsedOf(state: LoopState): number {
	const base = state.pausedAt ?? Date.now();
	return base - state.startedAt - (state.pausedMs ?? 0);
}

/** 已运行时长：中文长格式（widget 用） */
function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}小时${String(m).padStart(2, "0")}分`;
	if (m > 0) return `${m}分${String(sec).padStart(2, "0")}秒`;
	return `${sec}秒`;
}

/** 已运行时长：短格式（footer 用，如 12:34 / 1:02:34） */
function formatElapsedShort(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// =========================================================================
// 工具函数
// =========================================================================

function parseArgs(input: string): { goal: string; maxIterations: number } {
	let maxIterations = DEFAULT_MAX_ITERATIONS;
	let goal = input;

	const maxMatch = goal.match(/^max=(\d+)\s+(.+)/);
	if (maxMatch) {
		maxIterations = parseInt(maxMatch[1]!, 10);
		if (maxIterations < 1) maxIterations = DEFAULT_MAX_ITERATIONS;
		if (maxIterations > 200) maxIterations = 200;
		goal = maxMatch[2]!;
	}

	return { goal, maxIterations };
}

function detectMarkers(text: string): { done: boolean; cont: boolean } {
	return {
		done: text.includes("[LOOP_DONE]") || isCompletionClaim(text),
		cont: text.includes("[LOOP_CONTINUE]"),
	};
}

/**
 * 完成声明检测（Codex 风格：模型自判完成）。
 * 只看回复末尾（最后 300 字符）：明确说"完成/结束/done"且没有"继续/下一步/未完成"等续做信号。
 */
function isCompletionClaim(text: string): boolean {
	const tail = text.slice(-300);
	if (/继续|下一步|接下来|待办|未完成|还要|剩余/.test(tail)) return false;
	return /\[LOOP_DONE\]|(?:任务|目标|全部)?(?:已)?完成|任务结束|全部搞定|(?:all\s+)?done|finished|completed|complete/.test(tail);
}

interface TextContentBlock {
	type: "text";
	text: string;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: unknown): b is TextContentBlock =>
				!!b && typeof b === "object" && (b as TextContentBlock).type === "text")
			.map((b) => b.text)
			.join(" ");
	}
	return "";
}

function getLastAssistantText(entries: any[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			const msg = e.message as { content?: string | { type: string; text: string }[] };
			if (Array.isArray(msg.content)) {
				let text = "";
				for (const block of msg.content) {
					if (block.type === "text") text += block.text;
				}
				return text;
			}
			if (typeof msg.content === "string") return msg.content;
			break;
		}
	}
	return "";
}

/** 最后一条 assistant 消息的 stopReason（agent_end 时判断连接错误用） */
function getLastStopReason(entries: any[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "assistant") {
			return (e.message as { stopReason?: string }).stopReason ?? "";
		}
	}
	return "";
}

// =========================================================================
// 扩展入口
// =========================================================================

export default function (pi: ExtensionAPI) {
	piRef = pi;
	// 启动/重载时从磁盘恢复持久化状态（分支状态在 session_start 时优先覆盖）
	let state: LoopState | null = loadStateFromDisk();
	if (state) {
		debugLog("恢复持久化状态: goal=" + state.goal.slice(0, 40) + " active=" + state.active + " paused=" + state.paused + " iter=" + state.iteration);
	}

	// -----------------------------------------------------------------------
	// UI 更新
	// -----------------------------------------------------------------------
	function updateUI(ctx: ExtensionContext) {
		if (!state) {
			ctx.ui.setStatus("loop", undefined);
			ctx.ui.setWidget("loop", undefined);
			return;
		}

		const prefix = state.paused ? "⏸" : "🔄";
		const shortGoal = truncateGoal(state.title ?? state.goal, 30);
		const widgetGoal = truncateGoal(state.title ?? state.goal, 40);
		const elapsed = elapsedOf(state);

		// --- 暂停中的循环：保留提示，方便 resume/stop ---
		if (state.paused) {
			ctx.ui.setStatus(
				"loop",
				ctx.ui.theme.fg(
					"warning",
					`⏸ 已暂停: ${shortGoal} [${formatElapsedShort(elapsed)}]`,
				),
			);
			ctx.ui.setWidget("loop", [
				"⏸ 循环已暂停（未结束）",
				`⏱ 已运行 ${formatElapsed(elapsed)}`,
				`目标: ${widgetGoal}`,
				"▶️ /loop resume 继续 | 🛑 /loop stop 结束",
			]);
			return;
		}

		ctx.ui.setStatus(
			"loop",
			ctx.ui.theme.fg(
				state.paused ? "warning" : "accent",
				`${prefix} ${shortGoal} [${formatElapsedShort(elapsed)}]`,
			),
		);

		if (isFinite(state.maxIterations)) {
			const pct = Math.min(100, Math.round((state.iteration / state.maxIterations) * 100));
			const barWidth = 20;
			const filled = Math.round((pct / 100) * barWidth);
			ctx.ui.setWidget("loop", [
				`${prefix} 循环进行中`,
				`⏱ 已运行 ${formatElapsed(elapsed)}`,
				`目标: ${widgetGoal}`,
				`进度: ${"█".repeat(filled)}${"░".repeat(barWidth - filled)} ${pct}%`,
				state.paused ? "⏸ 已暂停，/loop resume 恢复" : "💡 Escape 暂停 | /loop stop 结束",
			]);
		} else {
			ctx.ui.setWidget("loop", [
				`${prefix} 循环进行中`,
				`⏱ 已运行 ${formatElapsed(elapsed)}`,
				`目标: ${widgetGoal}`,
				state.paused ? "⏸ 已暂停，/loop resume 恢复" : "💡 Escape 暂停 | /loop stop 结束",
			]);
		}
	}

	// -----------------------------------------------------------------------
	// 发送消息（带重试）
	// -----------------------------------------------------------------------
	function sendMessage(msg: string, ctx: ExtensionContext): void {
		let attempt = 0;

		function trySend() {
			attempt++;
			try {
				if (ctx.isIdle()) {
					pi.sendUserMessage(msg);
				} else {
					pi.sendUserMessage(msg, { deliverAs: "followUp" });
				}
				// 发送成功
			} catch (err) {
				if (attempt < MAX_RETRIES) {
					console.error(`[loop] sendMessage 失败 (第${attempt}次)，${RETRY_DELAY_MS}ms 后重试:`, err);
					setTimeout(trySend, RETRY_DELAY_MS);
				} else {
					console.error(`[loop] sendMessage 已重试 ${MAX_RETRIES} 次仍失败:`, err);
					if (state) {
						state.active = false;
						state.paused = true;
						updateUI(ctx);
						ctx.ui.notify("⚠️ 循环因发送消息失败已暂停，/loop resume 可重试", "error");
					}
				}
			}
		}

		trySend();
	}

	// -----------------------------------------------------------------------
	// 生成续跑消息
	// -----------------------------------------------------------------------
	function buildFollowUpMessage(): string {
		return (
			`继续完成目标: "${state!.goal}"\n` +
			`这是第 ${state!.iteration}/${maxLabel(state!.maxIterations)} 轮。\n` +
			"持续执行直到任务真正完成。完成后请明确声明（如「✅ 已完成」或 [LOOP_DONE]）并总结成果；遇阻塞说明原因即可停下。"
		);
	}

	function buildInitialMessage(): string {
		return (
			`你的目标是: "${state!.goal}"\n\n` +
			`这是第 ${state!.iteration}/${maxLabel(state!.maxIterations)} 轮。\n` +
			"执行方式（持续执行，直到完成）：\n" +
			"1. **目标判据判断**：如果目标的完成判据已明确（可客观验证），直接开始执行，无需契约；如果目标模糊或完成标准不明确，第一轮先起草完成契约：\n" +
			"   [CONTRACT]\n" +
			"   完成判据: （客观可验证的标准）\n" +
			"   验证方法: （如何验证完成）\n" +
			"   关键约束: （不能违反的限制）\n" +
			"   [/CONTRACT]\n" +
			"   末尾用 [CONTRACT_PENDING] 标记，等待用户确认后再执行。\n" +
			"2. 用户确认（回复「开始执行」）后，继续执行目标。\n" +
			"3. 持续执行直到任务真正完成：完成后请明确声明（如「✅ 已完成」或 [LOOP_DONE]）并总结成果；不要中途停下等确认。\n" +
			"4. 每轮都要有实质进展；遇到无法解决的阻塞时说明原因后停下。"
		);
	}

	// =======================================================================
	// /loop 命令
	// =======================================================================
	pi.registerCommand("loop", {
		description: "循环工作 /loop <goal> | max=N <goal> | stop | pause | resume | status",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			debugLog("command /loop args=" + JSON.stringify(input.slice(0, 60)));

			if (!input) {
				ctx.ui.notify(
					"用法: /loop <目标> | /loop max=100 <目标> | stop | pause | resume | status",
					"info",
				);
				return;
			}

			// --- schedule/auto: 自动触发任务 ---
			if (input.startsWith("schedule ") || input === "auto" || input.startsWith("auto ")) {
				handleAutoCommand(input, ctx);
				return;
			}

			// --- stop ---
			if (input === "stop") {
				if (state) {
					const wasActive = state.active;
					state = null;
					persistState(null); // 主动停止：删除持久化状态
					updateUI(ctx);
					ctx.ui.notify(wasActive ? "🛑 循环已停止" : "没有活跃的循环", "info");
				} else {
					ctx.ui.notify("当前没有循环", "info");
				}
				return;
			}

			// --- pause ---
			if (input === "pause" || input === "p") {
				if (!state) {
					ctx.ui.notify("当前没有循环", "info");
					return;
				}
				if (!state.active) {
					ctx.ui.notify("循环已经暂停", "warning");
					return;
				}
				state.paused = true;
				state.active = false;
				state.pausedAt = Date.now();
				pendingSend = false; // 暂停时取消待发送
				persistState(state);
				updateUI(ctx);
				ctx.ui.notify(`⏸ 已暂停（第 ${state.iteration}/${maxLabel(state.maxIterations)} 轮）`, "info");
				return;
			}

			// --- resume ---
			if (input === "resume" || input === "r") {
				if (!state) {
					ctx.ui.notify("当前没有循环，请用 /loop <目标> 开始", "info");
					return;
				}
				if (state.active && !state.paused) {
					ctx.ui.notify("循环已经在运行", "info");
					return;
				}

				state.active = true;
				state.paused = false;
				if (state.pausedAt) {
					state.pausedMs = (state.pausedMs ?? 0) + (Date.now() - state.pausedAt);
					state.pausedAt = undefined;
				}
				// resume 时契约阶段直接进入执行
				if (state.phase === "contract") state.phase = "executing";
				pendingSend = false;
				persistState(state);
				updateUI(ctx);
				ctx.ui.notify(`▶️ 已恢复（第 ${state.iteration}/${maxLabel(state.maxIterations)} 轮）`, "info");
				sendMessage(buildFollowUpMessage(), ctx);
				return;
			}

			// --- status ---
			if (input === "status") {
				if (state) {
					const status = state.active
						? `🔄 已运行 ${formatElapsed(elapsedOf(state))}`
						: state.paused
							? `⏸ 已暂停（已运行 ${formatElapsed(elapsedOf(state))}）`
							: "已停止";
					ctx.ui.notify(`${status} — 目标: "${truncateGoal(state.goal, 50)}"`, "info");
				} else {
					ctx.ui.notify("当前没有循环", "info");
				}
				return;
			}

			// --- 启动新循环 ---
			if (state?.active && !state.paused) {
				ctx.ui.notify("已有循环在运行，请先 /loop stop", "warning");
				return;
			}

			// 覆盖暂停的循环
			if (state) {
				state = null;
			}

			const { goal, maxIterations } = parseArgs(input);

			state = {
				goal,
				iteration: 1,
				maxIterations,
				active: true,
				paused: false,
				startedAt: Date.now(),
				pausedMs: 0,
				phase: "executing", // 默认直接执行；AI 判断目标模糊时才走契约确认
			};
			persistState(state);
			latestCtx = ctx; // 让 1s 定时刷新能更新运行时间

			updateUI(ctx);
			ctx.ui.notify(`🔄 循环开始: "${goal}"（${isFinite(maxIterations) ? `最多 ${maxIterations} 轮` : "无限循环"}）`, "info");
			sendMessage(buildInitialMessage(), ctx);
			// LLM 提取短标题（异步，不阻塞启动；失败回退到截断目标）
			(async () => {
				const title = await summarizeGoal(ctx, goal);
				if (title && state?.goal === goal && state.active) {
					state.title = title;
					persistState(state);
					updateUI(ctx);
				}
			})();
		},
	});

	// =======================================================================
	// 契约确认（用户回复"开始执行"时进入执行阶段）
	// =======================================================================
	pi.on("input", (event, ctx) => {
		if (!state?.paused || state.phase !== "contract") return undefined;
		const text = (event.text ?? "").trim();
		if (/^(开始执行|确认|开始|approve)/i.test(text)) {
			state.phase = "executing";
			state.active = true;
			state.paused = false;
			state.pausedAt = undefined;
			persistState(state);
			updateUI(ctx);
			ctx.ui.notify("✅ 契约已确认，开始执行", "success");
			debugLog("契约确认，进入执行阶段");
			setTimeout(() => {
				if (moduleDead || !state?.active || state.paused) return;
				sendMessage(buildFollowUpMessage() + "\n\n用户已确认完成契约，开始执行目标。", ctx);
			}, 300);
			return { action: "handled" }; // 消费输入，不交给 agent
		}
		return undefined;
	});

	// =======================================================================
	// 资源发现：注册 /create-goal prompt 模板
	// =======================================================================
	pi.on("resources_discover", () => {
		const promptsDir = path.join(EXT_DIR_LOOP, "..", "prompts");
		return { promptPaths: [promptsDir] };
	});

	// =======================================================================
	// 自动触发（定时 / 金价条件）
	// =======================================================================

	let latestCtx: ExtensionContext | null = null;
	let loopTimer: ReturnType<typeof setInterval> | undefined;

	// reload/会话切换时清理残留 UI（状态已重置，UI 不能还挂着旧面板）
	// 用 globalThis 标志跨模块实例传递"需要清理"信号（旧模块 shutdown 时设置）
	pi.on("session_shutdown", (_e, ctx) => {
		debugLog("session_shutdown reason=" + _e.reason);
		moduleDead = true;
		// 关键：杀掉本模块的定时器，否则 reload 后旧 interval 会把面板重新画回来
		if (loopTimer) {
			clearInterval(loopTimer);
			loopTimer = undefined;
		}
		// 兜底：quit/reload 前最后一次落盘（防止状态丢失）
		if (state) {
			persistState(state);
			debugLog("shutdown 兜底持久化: active=" + state.active + " paused=" + state.paused);
		}
		ctx.ui.setWidget("loop", undefined);
		ctx.ui.setStatus("loop", undefined);
		setStaleFlag(true);
	});
	pi.on("session_start", (e, ctx) => {
		debugLog("session_start reason=" + e.reason + " stale=" + getStaleFlag() + " restored=" + !!state);
		const stale = getStaleFlag();
		if (stale) {
			setStaleFlag(false);
			ctx.ui.setWidget("loop", undefined);
			ctx.ui.setStatus("loop", undefined);
			debugLog("残留 UI 已清理");
		}
		latestCtx = ctx;

		// --- 分支状态优先恢复（pi 原生，跟随 fork/导航）；文件状态兜底 ---
		const branchState = loadStateFromBranch(ctx);
		if (branchState !== null) {
			state = branchState;
			persistState(state); // 同步回文件
			debugLog("分支恢复: goal=" + state.goal.slice(0, 30) + " active=" + state.active);
		} else {
			const branchEnded = (() => {
				try {
					const branch = ctx.sessionManager.getBranch();
					for (let i = branch.length - 1; i >= 0; i--) {
						const en = branch[i];
						if (en.type === "custom" && en.customType === "loop-state") {
							return !!((en.data as Record<string, unknown> | null | undefined)?.ended);
						}
					}
				} catch { /* ignore */ }
				return false;
			})();
			if (branchEnded) {
				state = null;
				persistState(null); // 该分支已结束，清理文件残留
				debugLog("分支标记已结束，清除状态");
			}
		}

		// --- 恢复持久化的循环 ---
		if (state?.paused) {
			persistState(state); // 恢复后立即重写，确保文件存在
			// 暂停中的循环：显示暂停面板，等待用户 resume
			updateUI(ctx);
			ctx.ui.notify(
				`♻️ 已恢复暂停中的循环: "${truncateGoal(state.goal, 30)}" — /loop resume 继续，/loop stop 结束`,
				"info",
			);
		} else if (state?.active) {
			persistState(state); // 恢复后立即重写，确保文件存在
			// 运行中的循环：恢复面板 + 自动续跑
			updateUI(ctx);
			ctx.ui.notify(`♻️ 已恢复循环: "${truncateGoal(state.goal, 30)}"`, "info");
			// 延迟发送，等待 agent 空闲
			setTimeout(() => {
				if (moduleDead || !state?.active || state.paused) return;
				debugLog("恢复后自动续跑 followUp");
				sendMessage(buildFollowUpMessage(), ctx);
			}, 800);
		}
	});

	// 从事件中持续更新最新 ctx（reload/会话切换后仍可用）
	pi.on("before_agent_start", async (_e, ctx) => {
		latestCtx = ctx;
		if (!state?.active) return undefined;

		return {
			systemPrompt:
				_e.systemPrompt +
				`\n\n## Loop Mode（循环模式）\n` +
				`你正在循环执行以下目标:\n"${state.goal}"\n` +
				`当前进度: 第 ${state.iteration}/${maxLabel(state.maxIterations)} 轮\n\n` +
				`规则:\n` +
				`1. 每次回复末尾，必须加上 [LOOP_CONTINUE] 或 [LOOP_DONE]\n` +
				`2. [LOOP_CONTINUE] = 还需要继续，下一轮自动续跑\n` +
				`3. [LOOP_DONE] = 目标已完成\n` +
				`4. 每轮都要有实质进展，不要重复做同一件事\n` +
				`5. 不要每步都征求用户同意，主动使用所有可用工具`,
		};
	});

	// 定时检查自动任务 + 刷新运行时间显示（1 秒）
	loopTimer = setInterval(() => {
		if (moduleDead) return;
		// 兜底：若残留标志存在（reload 后事件链失效），主动清理
		if (getStaleFlag() && latestCtx) {
			setStaleFlag(false);
			ctxForAuto()?.ui.setWidget("loop", undefined);
			ctxForAuto()?.ui.setStatus("loop", undefined);
			debugLog("interval 兜底清理残留 UI");
		}
		// 运行时间刷新（仅运行中需要；暂停时时间冻结，面板静态，避免每秒重绘干扰 TUI）
		if (state?.active && latestCtx) {
			updateUI(latestCtx);
		}

		if (autoTasks.length === 0) return;
		const now = new Date();
		const today = dayKey(now);

		for (const t of autoTasks) {
			if (t.fired) continue;
			let hit = false;

			if (t.kind === "time") {
				if (t.delayMs !== undefined) {
					hit = now.getTime() >= t.createdAt + t.delayMs;
				} else if (t.dailyTime) {
					if (t.lastFiredDay === today) continue; // 今天已触发
					const [h, m] = t.dailyTime.split(":").map(Number);
					const curMin = now.getHours() * 60 + now.getMinutes();
					hit = curMin >= h * 60 + m;
				}
				if (hit && t.dailyTime) t.lastFiredDay = today;
			}

			if (hit) {
				t.fired = true;
				startAutoLoop(t, ctxForAuto());
			}
		}

		autoTasks = autoTasks.filter((t) => !t.fired || !!t.dailyTime);
		persistTasks(autoTasks);
	}, 1000);

	function ctxForAuto(): ExtensionContext | undefined {
		return latestCtx ?? undefined;
	}

	function startAutoLoop(t: AutoTask, ctx?: ExtensionContext) {
		if (state?.active) {
			debugLog(`自动任务 "${t.description}" 命中，但已有循环在运行，跳过`);
			return;
		}
		state = {
			goal: t.goal,
			iteration: 1,
			maxIterations: t.maxIterations,
			active: true,
			paused: false,
			startedAt: Date.now(),
			pausedMs: 0,
			phase: "executing", // 默认直接执行；自动触发同样由 AI 判断是否走契约
		};
		persistState(state);
		if (ctx) {
			updateUI(ctx);
			ctx.ui.notify(`⚡ 自动触发循环: "${t.goal}"`, "info");
		}
		debugLog(`自动触发: ${t.description}`);
		if (ctx) {
			sendMessage(buildInitialMessage(), ctx);
			// LLM 提取短标题（异步；失败回退到截断目标）
			(async () => {
				const title = await summarizeGoal(ctx, t.goal);
				if (title && state?.goal === t.goal && state.active) {
					state.title = title;
					persistState(state);
					updateUI(ctx);
				}
			})();
		} else {
			debugLog("自动触发但没有可用 ctx，等待下一轮检查重试");
			state.active = false;
			state.paused = true;
		}
	}

	function handleAutoCommand(input: string, ctx: ExtensionCommandContext) {
		// --- auto list ---
		if (input === "auto" || input === "auto list") {
			if (autoTasks.length === 0) {
				ctx.ui.notify("没有自动任务。用 /loop schedule 添加", "info");
				return;
			}
			const lines = autoTasks.map((t) => `[${t.id}] ${t.description} ${t.fired ? "(已触发)" : "(待触发)"}`);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		// --- auto cancel <id> ---
		if (input.startsWith("auto cancel ")) {
			const id = input.slice("auto cancel ".length).trim();
			const before = autoTasks.length;
			autoTasks = autoTasks.filter((t) => t.id !== id);
			ctx.ui.notify(
				autoTasks.length < before ? `已取消自动任务 [${id}]` : `未找到任务 [${id}]`,
				"info",
			);
			return;
		}

		// --- schedule in=30m <goal> ---
		let m = input.match(/^schedule\s+in=(\d+)([mh])\s+(.+)$/);
		if (m) {
			const n = parseInt(m[1]!, 10);
			const unit = m[2]!;
			const delayMs = (unit === "h" ? n * 3600 : n * 60) * 1000;
			const task: AutoTask = {
				id: "t" + (autoTasks.length + 1) + "-" + Date.now().toString(36).slice(-4),
				kind: "time",
				goal: m[3]!.trim(),
				maxIterations: DEFAULT_MAX_ITERATIONS,
				description: `${delayMs / 60000} 分钟后自动开始`,
				delayMs,
				createdAt: Date.now(),
				fired: false,
			};
			autoTasks.push(task);
			persistTasks(autoTasks);
			latestCtx = ctx;
			ctx.ui.notify(`⏰ 已安排: ${task.description} → "${task.goal}" [${task.id}]`, "info");
			return;
		}

		// --- schedule 09:30 <goal> (每日) ---
		m = input.match(/^schedule\s+(\d{1,2}:\d{2})\s+(.+)$/);
		if (m) {
			const task: AutoTask = {
				id: "d" + (autoTasks.length + 1) + "-" + Date.now().toString(36).slice(-4),
				kind: "time",
				goal: m[2]!.trim(),
				maxIterations: DEFAULT_MAX_ITERATIONS,
				description: `每天 ${m[1]} 自动开始`,
				dailyTime: m[1]!,
				createdAt: Date.now(),
				fired: false,
			};
			autoTasks.push(task);
			persistTasks(autoTasks);
			latestCtx = ctx;
			ctx.ui.notify(`⏰ 已安排: ${task.description} → "${task.goal}" [${task.id}]`, "info");
			return;
		}

		ctx.ui.notify(
			"用法:\n" +
				"/loop schedule in=30m <目标> — 30分钟后自动开始\n" +
				"/loop schedule 09:30 <目标> — 每天09:30自动开始\n" +
				"/loop auto list — 查看任务\n" +
				"/loop auto cancel <id> — 取消任务",
			"info",
		);
	}

	// =======================================================================
	// agent_end：每轮结束后检查标记，决定是否继续
	// =======================================================================
	pi.on("agent_end", async (_event, ctx) => {
		debugLog("agent_end active=" + state?.active + " paused=" + state?.paused);
		latestCtx = ctx;
		if (!state?.active || state.paused) return;

		// 解析标记
		const lastText = getLastAssistantText(ctx.sessionManager.getEntries());
		const { done } = detectMarkers(lastText);

		// --- 契约起草阶段：[CONTRACT_PENDING] → 弹确认框（类似 permission 交互） ---
		if (lastText.includes("[CONTRACT_PENDING]")) {
			state.phase = "contract";
			if (ctx.hasUI) {
				const choice = await ctx.ui.select(
					`📝 完成契约已起草\n\n目标: ${truncateGoal(state.goal, 50)}\n\n选择：`,
					["✅ 开始执行", "📝 修改契约", "❌ 取消"],
				);
				if (choice === "✅ 开始执行") {
					state.phase = "executing";
					state.active = true;
					state.paused = false;
					state.pausedAt = undefined;
					persistState(state);
					updateUI(ctx);
					ctx.ui.notify("✅ 契约已确认，开始执行", "success");
					debugLog("契约确认（选择框），进入执行阶段");
					setTimeout(() => {
						if (moduleDead || !state?.active || state.paused) return;
						sendMessage(buildFollowUpMessage() + "\n\n用户已确认完成契约，开始执行目标。", ctx);
					}, 500);
					return;
				}
				if (choice === "📝 修改契约") {
					state.active = true;
					state.paused = false;
					state.pausedAt = undefined;
					persistState(state);
					updateUI(ctx);
					ctx.ui.notify("📝 请重新起草契约", "info");
					setTimeout(() => {
						if (moduleDead || !state?.active || state.paused) return;
						sendMessage(buildFollowUpMessage() + "\n\n用户要求修改契约：请重新起草 [CONTRACT]...[/CONTRACT] 并用 [CONTRACT_PENDING] 标记。", ctx);
					}, 500);
					return;
				}
				// 取消 → 暂停
				state.active = false;
				state.paused = true;
				state.pausedAt = Date.now();
				persistState(state);
				updateUI(ctx);
				ctx.ui.notify("契约未确认，循环已暂停 — /loop stop 取消或 /loop resume 继续", "info");
				return;
			}
			// 无 UI：按旧逻辑暂停
			state.phase = "contract";
			state.active = false;
			state.paused = true;
			state.pausedAt = Date.now();
			persistState(state);
			updateUI(ctx);
			ctx.ui.notify("📝 完成契约已起草 — 回复「开始执行」确认后运行，或 /loop stop 取消", "info");
			return;
		}
		// --- 用户主动中止（ESC / abort）→ 安静暂停，不弹"未找到标记"警告 ---
		// 仅 signal.aborted 视为用户中止；空回复+stopReason=error 是连接错误，走重试
		if (ctx.signal?.aborted === true) {
			state.active = false;
			state.paused = true;
			state.pausedAt = Date.now();
			persistState(state);
			updateUI(ctx);
			ctx.ui.notify("⏸ 已暂停（你中止了本轮）— /loop resume 继续，/loop stop 结束", "info");
			return;
		}

		// --- 连接/网关错误（stopReason=error，如 terminated / Connection error）→ 不暂停、不续跑 ---
		// pi 会对可重试错误自动重试（重试成功会再次触发 agent_end）；
		// 若 pi 不重试（预算耗尽/非可重试），由 agent_settled 兜底续跑下一轮。
		if (getLastStopReason(ctx.sessionManager.getEntries()) === "error") {
			errorPending = true;
			debugLog("本轮连接错误（stopReason=error），等待 pi 重试或 settled 兜底");
			return;
		}
		errorPending = false; // 正常轮，清除错误待发标记

		// --- 空回复（stopReason 非 error 但无内容）→ 重试下一轮 ---
		if (lastText.trim().length === 0) {
			state.iteration++;
			pendingSend = true;
			persistState(state);
			updateUI(ctx);
			ctx.ui.notify("⚠️ 本轮回复异常（空回复），自动重试下一轮", "warning");
			debugLog("空回复，重试下一轮");
			return;
		}

		// --- 契约起草阶段：[CONTRACT_PENDING] → 弹确认框（类似 permission 交互） ---

		// --- 完成声明（模型自判，Codex 风格：明确说完成即结束） ---
		if (done) {
			const finalIteration = state.iteration;
			state.active = false;
			persistState(null); // 完成：删除持久化状态，不再恢复
			ctx.ui.setWidget("loop", [
				"✅ 目标已完成! 🎉",
				`目标: ${state.goal}`,
				`完成轮次: 第 ${finalIteration} 轮`,
			]);
			setTimeout(() => {
				if (!state || !state.active) ctx.ui.setWidget("loop", undefined);
			}, 5000);
			ctx.ui.notify("✅ 目标完成! 🎉", "success");
			debugLog("完成声明，循环结束（第 " + finalIteration + " 轮）");
			return;
		}

		// --- 已达最大轮数（仅限有限轮次时）→ 停止 ---
		if (isFinite(state.maxIterations) && state.iteration >= state.maxIterations) {
			const finalIteration = state.iteration;
			state.active = false;
			persistState(null); // 停止：删除持久化状态
			ctx.ui.setWidget("loop", [
				"🛑 循环已达最大轮数",
				`目标: ${state.goal}`,
				`已执行: ${finalIteration} 轮`,
			]);
			setTimeout(() => {
				if (!state || !state.active) ctx.ui.setWidget("loop", undefined);
			}, 5000);
			ctx.ui.notify(`🛑 已达最大 ${maxLabel(state.maxIterations)} 轮`, "warning");
			return;
		}

		// --- 未声明完成 → 自动续跑（Codex 风格：持续执行直到完成） ---
		state.iteration++;
		pendingSend = true;
		persistState(state);
		updateUI(ctx);
	});

	// agent_settled：agent 完全空闲后发送续跑消息（比 agent_end 更稳）
	pi.on("agent_settled", async (_e, ctx) => {
		latestCtx = ctx;
		if (moduleDead) return;
		if (!state?.active || state.paused) return;
		// 连接错误兜底：pi 未自动重试（重试预算耗尽/非可重试错误）→ 由我们续跑下一轮
		if (errorPending) {
			errorPending = false;
			state.iteration++;
			persistState(state);
			updateUI(ctx);
			ctx.ui.notify("⚠️ 本轮回复异常（连接错误），自动重试下一轮", "warning");
			debugLog("settled 兜底：连接错误后重试下一轮");
			sendMessage(buildFollowUpMessage(), ctx);
			return;
		}
		if (!pendingSend) return;
		pendingSend = false;
		debugLog("agent_settled 续跑 followUp");
		sendMessage(buildFollowUpMessage(), ctx);
	});
}

// =========================================================================
// 模块级：自动任务状态 + 工具函数
// =========================================================================

// 模块级状态（persistState 需要 pi 引用；autoTasks 从磁盘恢复）
let autoTasks: AutoTask[] = loadTasksFromDisk();
let moduleDead = false; // reload/卸载后置 true，阻止旧模块回调复活
let piRef: ExtensionAPI | null = null;
let pendingSend = false; // agent_end 后待发送的续跑消息（由 agent_settled 消费）
let errorPending = false; // stopReason=error 轮：等待 pi 自动重试，或由 agent_settled 兜底续跑

function dayKey(d: Date): string {
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

