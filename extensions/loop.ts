/**
 * Loop Mode Extension v3
 *
 * Continuously iterates on a goal until completion, similar to
 * Claude Code's /loop and Codex's goal mode.
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
 * 按 Escape 可随时中止。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

// =========================================================================
// 状态定义
// =========================================================================

interface LoopState {
	goal: string;
	iteration: number;
	maxIterations: number;
	active: boolean;
	paused: boolean;
	startedAt: number; // 循环开始时间戳（ms），用于显示已运行时长
	pausedAt?: number; // 进入暂停的时间戳，暂停期间时间冻结
	pausedMs: number; // 累计暂停时长（ms），resume 时累加
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
		done: text.includes("[LOOP_DONE]"),
		cont: text.includes("[LOOP_CONTINUE]"),
	};
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

// =========================================================================
// 扩展入口
// =========================================================================

export default function (pi: ExtensionAPI) {
	let state: LoopState | null = null;

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
		const shortGoal = truncateGoal(state.goal, 30);
		const widgetGoal = truncateGoal(state.goal, 40);
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
			`完成后请用 [LOOP_CONTINUE] 或 [LOOP_DONE] 标记。`
		);
	}

	function buildInitialMessage(): string {
		return (
			`你的目标是: "${state!.goal}"\n\n` +
			`这是第 ${state!.iteration}/${maxLabel(state!.maxIterations)} 轮。\n` +
			"规则：\n" +
			"1. 每轮结束后，用 [LOOP_CONTINUE] 表示还需要继续。\n" +
			"2. 如果目标已完成，用 [LOOP_DONE] 表示。\n" +
			"3. 每轮都要有实质进展。"
		);
	}

	// =======================================================================
	// /loop 命令
	// =======================================================================
	pi.registerCommand("loop", {
		description: "循环工作 /loop <goal> | max=N <goal> | stop | pause | resume | status",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();

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
			};
			latestCtx = ctx; // 让 1s 定时刷新能更新运行时间

			updateUI(ctx);
			ctx.ui.notify(`🔄 循环开始: "${goal}"（${isFinite(maxIterations) ? `最多 ${maxIterations} 轮` : "无限循环"}）`, "info");
			sendMessage(buildInitialMessage(), ctx);
		},
	});

	// =======================================================================
	// 自动触发（定时 / 金价条件）
	// =======================================================================

	let latestCtx: ExtensionContext | null = null;
	let loopTimer: ReturnType<typeof setInterval> | undefined;

	// reload/会话切换时清理残留 UI（状态已重置，UI 不能还挂着旧面板）
	// 用 globalThis 标志跨模块实例传递"需要清理"信号（旧模块 shutdown 时设置）
	pi.on("session_shutdown", (_e, ctx) => {
		console.log("[loop] session_shutdown");
		moduleDead = true;
		// 关键：杀掉本模块的定时器，否则 reload 后旧 interval 会把面板重新画回来
		if (loopTimer) {
			clearInterval(loopTimer);
			loopTimer = undefined;
		}
		ctx.ui.setWidget("loop", undefined);
		ctx.ui.setStatus("loop", undefined);
		(globalThis as any).__loopStaleUI = true;
	});
	pi.on("session_start", (e, ctx) => {
		console.log("[loop] session_start reason=" + e.reason + " stale=" + (globalThis as any).__loopStaleUI);
		const stale = (globalThis as any).__loopStaleUI === true;
		if (stale || e.reason === "reload") {
			(globalThis as any).__loopStaleUI = false;
			ctx.ui.setWidget("loop", undefined);
			ctx.ui.setStatus("loop", undefined);
			console.log("[loop] 残留 UI 已清理");
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
		if ((globalThis as any).__loopStaleUI && latestCtx) {
			(globalThis as any).__loopStaleUI = false;
			ctxForAuto()?.ui.setWidget("loop", undefined);
			ctxForAuto()?.ui.setStatus("loop", undefined);
			console.log("[loop] interval 兜底清理残留 UI");
		}
		// 运行时间刷新（运行中或暂停中都刷新）
		if (state && latestCtx) {
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
	}, 1000);

	function ctxForAuto(): ExtensionContext | undefined {
		return latestCtx ?? undefined;
	}

	function startAutoLoop(t: AutoTask, ctx?: ExtensionContext) {
		if (state?.active) {
			console.log(`[loop] 自动任务 "${t.description}" 命中，但已有循环在运行，跳过`);
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
		};
		if (ctx) {
			updateUI(ctx);
			ctx.ui.notify(`⚡ 自动触发循环: "${t.goal}"`, "info");
		}
		console.log(`[loop] 自动触发: ${t.description}`);
		if (ctx) {
			sendMessage(buildInitialMessage(), ctx);
		} else {
			console.warn("[loop] 自动触发但没有可用 ctx，等待下一轮检查重试");
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
		latestCtx = ctx;
		if (!state?.active || state.paused) return;

		// 解析标记
		const lastText = getLastAssistantText(ctx.sessionManager.getEntries());
		const { done, cont } = detectMarkers(lastText);

		// --- 用户主动中止（ESC / abort）→ 安静暂停，不弹"未找到标记"警告 ---
		const userAborted = ctx.signal?.aborted === true || lastText.trim().length === 0;
		if (userAborted) {
			state.active = false;
			state.paused = true;
			state.pausedAt = Date.now();
			updateUI(ctx);
			ctx.ui.notify("⏸ 已暂停（你中止了本轮）— /loop resume 继续，/loop stop 结束", "info");
			return;
		}

		// --- [LOOP_DONE] → 目标完成 ---
		if (done) {
			const finalIteration = state.iteration;
			state.active = false;
			ctx.ui.setWidget("loop", [
				"✅ 目标已完成! 🎉",
				`目标: ${state.goal}`,
				`完成轮次: 第 ${finalIteration} 轮`,
			]);
			setTimeout(() => {
				if (!state || !state.active) ctx.ui.setWidget("loop", undefined);
			}, 5000);
			ctx.ui.notify("✅ 目标完成! 🎉", "success");
			return;
		}

		// --- 无标记（AI 忘了标记）→ 暂停 ---
		if (!cont) {
			state.active = false;
			state.paused = true;
			updateUI(ctx);
			ctx.ui.notify("⚠️ AI 回复末尾缺少 [LOOP_CONTINUE] 或 [LOOP_DONE] 标记，已暂停。可 /loop resume 继续", "warning");
			return;
		}

		// --- 已达最大轮数（仅限有限轮次时）→ 停止 ---
		if (isFinite(state.maxIterations) && state.iteration >= state.maxIterations) {
			const finalIteration = state.iteration;
			state.active = false;
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

		// --- [LOOP_CONTINUE] → 继续下一轮 ---
		state.iteration++;
		updateUI(ctx);

		// 延迟发送，等待 agent 完全进入空闲状态
		setTimeout(() => {
			if (moduleDead || !state?.active || state.paused) return;
			sendMessage(buildFollowUpMessage(), ctx);
		}, 500);
	});
}

// =========================================================================
// 模块级：自动任务状态 + 工具函数
// =========================================================================

let autoTasks: AutoTask[] = [];
let moduleDead = false; // reload/卸载后置 true，阻止旧模块回调复活

function dayKey(d: Date): string {
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

