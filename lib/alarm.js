/** dsh-alarm 的宿主侧投递层：把「需要用户注意」的时刻变成听得见、看得见的报警。
 *
 * 触发（只对 runtime root 会话，子智能体会话一律不提醒）——**每种触发各有一个开关**：
 *  1. `tools/pre-execute` 命中 `ask_user_question` → kind `ask`「需要你的裁决」；
 *     命中 `exit_plan_mode` → kind `plan`「需要你确认计划」（各走各的开关）。
 *  2. `tools/pre-execute` 命中 `update_goal` 且 `action === "complete"` → kind
 *     `task-complete`「全部任务完成」。**这是「全部任务完成」的唯一入口**：普通轮次
 *     结束不是完成信号。（早期版本在 turn/end 与 idle 上用「该会话没有活动 goal」兜底，
 *     结果从未调用过 goal 工具的会话每轮都误报一次完成；该兜底已删除，也不再跟踪
 *     goal 活动标记。）
 *  3. `session/event` 的 `turn/end`：reason.completed → kind `turn-end`「本轮结束」
 *     （默认关；关掉时 completed 收尾**什么都不响**）；reason 非 completed
 *     时按 reason 分两类：命中中止词（abort / interrupt / cancel / stop / user）→
 *     kind `turn-interrupt`「本轮中断（reason）」；其余（error / failed / max-tokens …）
 *     → kind `turn-error`「本轮报错（reason）」（两者都默认关，各走各的开关）。
 *  4. `agent/status` 变 idle 的兜底（比 turn/end 更晚更粗，只在没有 turn/end 时生效）：
 *     alertTurnEnd 开 → `turn-end`；否则什么都不响（idle 不是完成信号）。
 *  5. 设置页「测试提醒」→ kind `test`：受 alertTest 控制（默认开）；三条通道
 *     与其他条件一样按 popupTest / soundTest / voiceTest 判定。
 *  6. `tools/pre-execute` 命中 write/edit（或 pwsh/bash/shell 命令行）且目标是
 *     `03-开发协同/<任务>/状态.md`，**并且这次调用真的把该文件的「当前阶段」从别的值
 *     改成了「待人工测试」** → kind `awaiting-test`「任务到「待人工测试」」
 *     （同一状态文件 5 分钟内只响一次）：这正是自动开发调度器把任务包推进到
 *     「待人工测试」的那一刻。判定口径是**文件真实状态变化**：写前同步读旧相位 →
 *     写完 1.2s 后复读校验；入参文本（write 的 content / edit 的 new_string /
 *     pwsh 的整条 command）里「提到」这句话一律不算——命令里顺带出现状态文件路径与
 *     「当前阶段：待人工测试」字样（拼脚本、写文档、思考后生成的多段脚本）不再误报。
 *  7. `session/event` 的 `turn/end`（reason.completed）：agent 这一轮**最后一条**回复
 *     正文里提到「要重启 DSH 才生效」→ 改报 kind `restart`「需要重启 DSH」
 *     （受 alertRestart 控制，默认开；命中时**不再**额外响「本轮结束」，避免双响）。
 *     正文优先取 `assistant/message` 事件（只拼 text part，跳过 reasoning 与 tool-call）；
 *     命中判定走纯函数 `restartHitOf`：否定说法、未来时/条件句、围栏代码块里的引用都不算；
 *     该会话这轮没收到事件时，按 sessionId 到 `<DSH_HOME>/sessions/<slug>/<id>/` 读
 *     会话日志的最后一条 `assistant/message` 兜底（日志是「每批事件一帧」的 zstd 拼接，
 *     这里照 DSH 自己的做法先扫帧边界再逐帧解压）。读文件的任何异常只记日志。
 *  8. **正文标签通道（严格输出协议）**：agent 在这一轮正文里**独占一行**写下
 *     `[[ALARM:RESTART]]` / `[[ALARM:TEST:<任务名>]]` / `[[ALARM:STALLED]]` 等标签
 *     （判定见纯函数 `parseAlarmTags`）时，**以标签为准**：RESTART → `restart`；
 *     TEST → `awaiting-test`（正文与节流/聚合规则与状态文件通道完全一致，去重键换成任务名）；
 *     STALLED → `stalled`。`ASK` / `PLAN` / `DONE` 三个标签只记一条 `{ev:'tag'}` 日志
 *     （对应事件已由工具调用触发，标签是给人看的可读副本）。
 *     **`protocolMode` 是两态枚举**（标签与旧判定各自覆盖「需要重启 DSH」与「待人工测试」
 *     两条通道；`stalled` 的标签不受它控制，从来只有「标签 + 启发式」两条并列通道）：
 *       `tag-first`（默认模式）——**标签优先，未命中标签时用旧判定兜底**：
 *         RESTART 标签没命中 → 仍按正文正则 `restartHitOf` 判重启；
 *         TEST 标签没命中 → 状态文件相位监视**照常启用**（`tools/pre-execute`）。
 *         同一轮内标签与旧判定都命中时**只响一次**（restart 分支 raise 后立即 return）。
 *       `tag-only`（严格模式）——只认标签：两条旧判定整条关闭（重启不看正文、待测不监视状态文件）。
 *     旧的第三态 `heuristic-only` 已删除：历史配置里残留的 `true` / `false` / `"heuristic-only"`
 *     一律由 `protocolModeOf()` 归一化成 `tag-first`（默认模式，绝不静默吞掉旧判定）。
 *  9. `session/event` 的 `turn/end`（reason.completed）且**这一轮没有任何工具调用**、
 *     没有请你裁决、也没有命中重启/待测标签，并且该会话**确实有活跃 goal**
 *     （跟踪 `update_goal`：`complete` → 完成，其余 action → 活跃；从未见过 → 未知、不响）
 *     → kind `stalled`「Agent 停下来且没有后续动作」（受 alertStalled 控制，默认开；
 *     同一 agent 10 分钟内只响一次）。重启/待测命中时优先，不再报 stalled；
 *     stalled 优先于「本轮结束」，不会双响。
 *
 * 投递：每次提醒 spawn 一个隐藏窗口、detached 的 powershell.exe（5.1，不是 pwsh 7：
 * WinRT toast 在 .NET Core PowerShell 里没有投影），执行一个**纯 ASCII** 的 .ps1：
 *   铃声（可配置 wav × 可配置次数）→ 可选 TTS 语音播报 → 可选弹窗
 *   （topmost=置顶窗口 / toast=系统消息）→ 弹窗通道开着、但窗口没能显示时再尽力发一次
 *   WinRT toast（弹窗通道关则 toast 也一起关：toast 是弹窗通道的兜底子通道，
 *   不是独立通道；`popupStyle = "toast"` 时窗口根本不起，只走这条 toast）。
 * 标题/正文/播报文本用 UTF-8 base64 传参，脚本文件本身不含任何非 ASCII 字符，
 * 避免 PowerShell 5.1 按 ANSI 代码页读取导致的解析失败。
 * 所有失败都被吞掉：报警绝不允许打断或拖垮一轮对话。
 *
 * 三条通道**按条件各有一把开关**：`popup<Kind>` / `sound<Kind>` / `voice<Kind>`
 * 决定这条提醒走哪几条通道，与三块通道总开关（`popup` / `soundEnabled` /
 * `voice`）是「与」关系；`popupStyle` 只决定弹窗通道**怎么呈现**（topmost=置顶窗口、
 * toast=系统通知），不再有「不弹」这个取值——要关弹窗用 `popup` 总开关或
 * `popup<Kind>`。三条通道全关时不 spawn 脚本（省一次进程），只写一条
 * `raise-suppressed` 诊断日志。
 *
 * 配置（host/config.js 的扁平 volatile 字段）在**每次提醒时现读**：config 上的
 * volatile 字段是活引用，所以设置页保存后无需重载插件即刻生效。
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { isNetworkVoice, listInstalledVoices, pickOfflineVoice } from "./voices.js";

/** 报警资源目录（<DSH_HOME>/alarm）。 */
const SUBDIR = "alarm";
/** 生成到磁盘的 PowerShell 脚本名。 */
const SCRIPT_FILE = "toast-alert.ps1";
/** 诊断日志名（JSONL）。 */
const LOG_FILE = "alarm.log";
/** 日志轮转阈值。 */
const LOG_MAX_BYTES = 512 * 1024;
/** 会打断 Agent、等用户回答的工具 → 报警 kind（一个工具一个独立开关）。 */
const TOOL_KINDS = new Map([
	["ask_user_question", "ask"],
	["exit_plan_mode", "plan"],
]);

/** kind → 触发开关字段名（每个 kind 一个；test 也受 alertTest 控制）。 */
const SWITCH_OF_KIND = {
	ask: "alertAsk",
	plan: "alertPlan",
	"task-complete": "alertTaskComplete",
	"turn-end": "alertTurnEnd",
	"turn-interrupt": "alertTurnInterrupt",
	"turn-error": "alertTurnError",
	stalled: "alertStalled",
	test: "alertTest",
	"awaiting-test": "alertAwaitingTest",
	restart: "alertRestart",
};

/** kind → 该条提醒三条通道的字段名后缀（`popup<Kind>` / `sound<Kind>` / `voice<Kind>`）。
 *  与 SWITCH_OF_KIND 的 kind 一一对应；未知 kind 一律按「通道开着」处理。 */
const CHANNEL_SUFFIX_OF_KIND = {
	ask: "Ask",
	plan: "Plan",
	"task-complete": "TaskComplete",
	restart: "Restart",
	"awaiting-test": "AwaitingTest",
	"turn-end": "TurnEnd",
	"turn-interrupt": "TurnInterrupt",
	"turn-error": "TurnError",
	stalled: "Stalled",
	test: "Test",
};

/** kind → 该条提醒自己的播报文本字段名（空串时回落到兜底模板 voiceText）。 */
const VOICE_TEXT_OF_KIND = {
	ask: "voiceTextAsk",
	plan: "voiceTextPlan",
	"task-complete": "voiceTextTaskComplete",
	"turn-end": "voiceTextTurnEnd",
	"turn-interrupt": "voiceTextInterrupt",
	"turn-error": "voiceTextError",
	"awaiting-test": "voiceTextAwaitingTest",
	restart: "voiceTextRestart",
	stalled: "voiceTextStalled",
	test: "voiceTextTest",
};

/** 设置页「条件表逐行试听」允许的 kind 白名单（顺序即前端行序，不要改名）。
 *  非法/缺省 kind 一律按 "test" 处理。 */
export const TEST_KINDS = [
	"ask",
	"plan",
	"task-complete",
	"restart",
	"awaiting-test",
	"turn-end",
	"turn-interrupt",
	"turn-error",
	"stalled",
	"test",
];

/** 试听时每种 kind 的模拟标题/正文（正文统一以「（试听）」开头，末尾仍带「（dsh-alarm）」）。 */
const TEST_MESSAGE_OF_KIND = {
	ask: { title: "需要你的裁决", body: "（试听）Agent 停下来等你做选择。" },
	plan: { title: "需要你确认计划", body: "（试听）Agent 提交了计划，等你确认。" },
	"task-complete": { title: "全部任务完成", body: "（试听）Agent 报告全部任务已完成。" },
	restart: { title: "需要重启 DSH", body: "（试听）需要重启 DSH 才生效。" },
	"awaiting-test": {
		title: "任务到「待人工测试」",
		body: "（试听）TP-示例 已到「待人工测试」，请回到 DSH 窗口实测。",
	},
	"turn-end": { title: "本轮结束", body: "（试听）这一轮跑完了。" },
	"turn-interrupt": { title: "本轮中断", body: "（试听）这一轮被手动打断。" },
	"turn-error": { title: "本轮报错", body: "（试听）这一轮异常结束。" },
	stalled: { title: "Agent 停下来且没有后续动作", body: "（试听）这一轮没有工具调用也没有请你裁决。" },
	test: {
		title: "报警提醒测试",
		body: "（试听）这是 dsh-alarm 的试听提醒：铃声、语音与弹窗按当前设置生效。",
	},
};

/** turn/end 的 reason 命中这些词就算「被手动打断」，否则算「异常报错」。 */
const INTERRUPT_RE = /abort|interrupt|cancel|stop|user/i;

/** agent 这一轮最后一条回复正文命中这些说法 → 「这次改动需要重启 DSH 才生效」。 */
const RESTART_RE =
	/(?:重启|重新启动)\s*(?:DSH|dsh|客户端|软件|程序|应用)|(?:restart|reload)\s+(?:the\s+)?(?:dsh|app|client)|重启后生效|需要重启|请重启/iu;

/** 否定说法（「不需要重启」「现在不要重启」…）：判命中前先摘掉，免得把「不用重启」当成「要重启」。 */
const NEGATED_RESTART_RE =
	/(?:不需要|无须|无需|不必|不用|不要|别|勿|暂不|先不|不能|不会|不打算|不准备)\s*(?:重启|重新启动)[^\n。；;]{0,12}/gu;

/** 未来时/条件说法（「等改完再通知你重启」「完成后我会告诉你重启」…）：还没到重启的时候，一律不算。 */
const FUTURE_RESTART_RE =
	/(?:等|待|再通知|通知你|告诉你|稍后|之后|回头|改完|完成后|收尾后|搞定后)[^\n。；;]{0,24}?(?:重启|重新启动)[^\n。；;]{0,12}/gu;

/** 围栏代码块（三反引号包起来的片段）：文档/代码里引用的重启说明不是「这一轮在叫你重启」。 */
const FENCED_CODE_RE = /```[\s\S]*?```/gu;

/** 正文标签协议（严格输出协议）：`[[ALARM:ASK]]` / `[[ALARM:PLAN]]` / `[[ALARM:DONE]]` /
 *  `[[ALARM:RESTART]]` / `[[ALARM:STALLED]]` / `[[ALARM:TEST:<任务名>]]`。
 *
 *  - **区分大小写**：只认大写 kind（`alarm:restart` 一律不算）；
 *  - **必须独占一行**：行首行尾只允许空白（`[ \t]*`，行尾另容忍 CRLF 的 `\r`）；
 *    「正文里顺带提到 [[ALARM:RESTART]]」这种行内出现不算；
 *  - TEST 的任务名取冒号后到 `]]` 前（`trim`，可为空串）。
 *
 *  **只许用 `matchAll`**：本正则带 `g`，对它调 `.test()` / `.exec()` 会移动 `lastIndex`，
 *  下一次解析就会从半截开始。 */
const ALARM_TAG_RE = /^[ \t]*\[\[ALARM:(ASK|PLAN|DONE|RESTART|STALLED|TEST(?::\s*([^\]]*))?)\]\][ \t]*\r?$/gmu;

/** 同一个 agent 的「停住」提醒在这么久之内只响一次。 */
const STALLED_DEDUPE_MS = 10 * 60 * 1000;

/** 同一个任务状态文件在这么久之内只提醒一次（修复轮重新回到待人工测试时会再响）。 */
const AWAITING_TEST_DEDUPE_MS = 5 * 60 * 1000;

/** 写完状态文件后等这么久再复读校验：工具返回时文件已落盘，留一点余量给
 *  「先写临时文件再 Move-Item 覆盖」这类写法。具名导出，便于自测与调参。 */
export const AWAITING_TEST_VERIFY_MS = 1200;

/** 状态.md 的「当前阶段」行：取冒号后面的相位值（行首允许装饰，全/半角冒号都认）。 */
const PHASE_RE = /^\s*当前阶段\s*[：:]\s*(.+)$/mu;

/** 目标相位：任务包被推进到「待人工测试」。 */
const AWAITING_PHASE = "待人工测试";

/** 从命令文本里抽候选状态文件路径：命中 `03-开发协同/<任务>/状态.md` 的连续非空白片段。
 *  只是「抽路径」，命中文本本身不构成提醒依据（见 awaitingTestCandidates 的注释）。 */
const STATUS_PATH_IN_COMMAND_RE = /[^\s"'`()<>|,;]*03-开发协同[\\/][^\\/\s"'`()<>|,;]+[\\/]状态\.md/gu;

/** 严格输出协议只有两种取值（与 host/config.js 的 PROTOCOL_MODES 一致）：`tag-first`（默认模式）
 *  与 `tag-only`（严格模式）。判定只比对这两个字面量，统一入口是 `protocolModeOf()`——
 *  旧的第三态 `heuristic-only` 与历史布尔值都在那里归一化成 `tag-first`，别再各处分头判。 */

/** 配置缺省值（与 host/config.js 的 schema 默认值保持一致）。 */
const DEFAULTS = {
	enabled: true,
	// 这张设置卡片注册/显示在哪里（三个空间各一个扁平 bool）：
	// 主窗口（侧栏铃铛 + 设置浮层）默认开；插件页 / 设置页默认关。
	showInMain: true,
	showInPlugins: false,
	showInSettings: false,
	alertAsk: true,
	alertPlan: true,
	alertTaskComplete: true,
	alertTurnEnd: false,
	alertTurnInterrupt: false,
	alertTurnError: true,
	alertStalled: true,
	alertTest: true,
	alertAwaitingTest: true,
	alertRestart: true,
	minTurnSeconds: 0,
	sound: "Alarm03.wav",
	soundRepeats: 1,
	soundEnabled: true,
	voice: true,
	voiceTextAsk: "需要你裁决",
	voiceTextPlan: "需要你确认计划",
	voiceTextTaskComplete: "全部任务完成",
	voiceTextTurnEnd: "本轮结束",
	voiceTextInterrupt: "本轮中断",
	voiceTextError: "本轮报错",
	voiceTextStalled: "我停下来了，没有后续动作",
	voiceTextAwaitingTest: "需要你手工测试",
	voiceTextRestart: "需要重启 DSH",
	voiceTextTest: "这是语音测试示例",
	voiceText: "{title}。{body}",
	voiceName: "",
	voiceRate: 0,
	voiceVolume: 100,
	popup: true,
	popupStyle: "topmost",
	// 每个条件的三条通道开关（默认值用户已确认：轻事件不弹窗，铃声/语音全开）。
	popupAsk: true,
	popupPlan: true,
	popupTaskComplete: true,
	popupRestart: false,
	popupAwaitingTest: true,
	popupTurnEnd: false,
	popupTurnInterrupt: false,
	popupTurnError: false,
	popupStalled: false,
	popupTest: true,
	soundAsk: true,
	soundPlan: true,
	soundTaskComplete: true,
	soundRestart: true,
	soundAwaitingTest: true,
	soundTurnEnd: true,
	soundTurnInterrupt: true,
	soundTurnError: true,
	soundStalled: true,
	soundTest: true,
	voiceAsk: true,
	voicePlan: true,
	voiceTaskComplete: true,
	voiceRestart: true,
	voiceAwaitingTest: true,
	voiceTurnEnd: true,
	voiceTurnInterrupt: true,
	voiceTurnError: true,
	voiceStalled: true,
	voiceTest: true,
	// 「待人工测试」提醒的批次/聚合规则（合并测试批次）。
	awaitingTestScope: "all",
	awaitingTestAnchor: "批次",
	awaitingTestQuietSeconds: 0,
	awaitingTestSummary: true,
	// 严格输出协议（两态，默认 tag-first=标签优先 + 旧判定兜底）：见文件头第 8 条的判定表。
	protocolMode: "tag-first",
	throttleSeconds: 4,
	askLatchSeconds: 15,
};

/** 读一个 volatile 字段的当前值；getter 抛错时退化为 undefined。
 *
 *  **必须解包**：schemastery 的 volatile 字段在配置对象上不是裸值，而是带 `.get()` 的
 *  取值器（读它才拿到设置里存的当前值）。不解包时 `typeof value === "boolean"` 恒为 false，
 *  boolOf/strOf/numOf 会一路回落到 DEFAULTS —— 表现就是「设置页改了、运行时全按默认值走」
 *  （试听不受总开关控制、弹窗关不掉、语音名回到系统默认）。host/routes.js 的 rawOf 一直
 *  有这层解包，两边口径必须一致。 */
function rawOf(config, key) {
	try {
		const value = config?.[key];
		if (value !== null && typeof value === "object" && typeof value.get === "function") {
			try {
				return value.get();
			} catch {
				return undefined;
			}
		}
		return value;
	} catch {
		return undefined;
	}
}

/** 布尔字段（非布尔则用默认值）。 */
function boolOf(config, key) {
	const value = rawOf(config, key);
	return typeof value === "boolean" ? value : DEFAULTS[key];
}

/** 字符串字段（非字符串则用默认值）。 */
function strOf(config, key) {
	const value = rawOf(config, key);
	return typeof value === "string" ? value : DEFAULTS[key];
}

/** 数字字段（有限数字后夹到 [min,max]，否则用默认值）。 */
function numOf(config, key, min, max) {
	const value = Number(rawOf(config, key));
	if (!Number.isFinite(value)) return DEFAULTS[key];
	return Math.min(max, Math.max(min, value));
}

/** 弹窗风格规整成两种模式之一（与 host/config.js 的 POPUP_STYLES 一致）：
 *  `toast`（系统消息）原样保留；其余——`topmost`（强弹窗）、旧值 `modal` / `none`、
 *  任何未知值——一律按强弹窗处理（旧值兼容，不报错）。 */
function popupStyleOf(style) {
	return style === "toast" ? "toast" : "topmost";
}

/** 严格协议模式规整成**两态**之一（与 host/config.js 的 PROTOCOL_MODES 一致）：
 *  只有 `tag-only`（严格模式）原样保留；**其余一律回落 `tag-first`（默认模式）**，
 *  包括旧配置里的布尔 `true` / `false`、已删除的第三态 `"heuristic-only"`、以及任何未知值。
 *  口径理由：默认模式 = 标签优先 + 旧判定兜底，最坏情况只是「多响一次」；
 *  绝不能让一个读不懂的旧值静默关掉旧判定（那会变成「提醒不响」这种更难发现的事故）。 */
function protocolModeOf(value) {
	return value === "tag-only" ? "tag-only" : "tag-first";
}

/** 把当前 config 读成一份规整的报警设置（每次提醒现读，不缓存）。 */
export function settingsOf(config) {
	const repeats = Math.round(numOf(config, "soundRepeats", 1, 5));
	const style = strOf(config, "popupStyle");
	return {
		enabled: boolOf(config, "enabled"),
		alertAsk: boolOf(config, "alertAsk"),
		alertPlan: boolOf(config, "alertPlan"),
		alertTaskComplete: boolOf(config, "alertTaskComplete"),
		alertTurnEnd: boolOf(config, "alertTurnEnd"),
		alertTurnInterrupt: boolOf(config, "alertTurnInterrupt"),
		alertTurnError: boolOf(config, "alertTurnError"),
		alertStalled: boolOf(config, "alertStalled"),
		alertTest: boolOf(config, "alertTest"),
		alertAwaitingTest: boolOf(config, "alertAwaitingTest"),
		alertRestart: boolOf(config, "alertRestart"),
		minTurnSeconds: numOf(config, "minTurnSeconds", 0, 86_400),
		sound: strOf(config, "sound") || DEFAULTS.sound,
		soundRepeats: repeats,
		soundEnabled: boolOf(config, "soundEnabled"),
		voice: boolOf(config, "voice"),
		voiceTextAsk: strOf(config, "voiceTextAsk"),
		voiceTextPlan: strOf(config, "voiceTextPlan"),
		voiceTextTaskComplete: strOf(config, "voiceTextTaskComplete"),
		voiceTextTurnEnd: strOf(config, "voiceTextTurnEnd"),
		voiceTextInterrupt: strOf(config, "voiceTextInterrupt"),
		voiceTextError: strOf(config, "voiceTextError"),
		voiceTextStalled: strOf(config, "voiceTextStalled"),
		voiceTextAwaitingTest: strOf(config, "voiceTextAwaitingTest"),
		voiceTextRestart: strOf(config, "voiceTextRestart"),
		voiceTextTest: strOf(config, "voiceTextTest"),
		voiceText: strOf(config, "voiceText"),
		voiceName: strOf(config, "voiceName"),
		voiceRate: Math.round(numOf(config, "voiceRate", -5, 5)),
		voiceVolume: Math.round(numOf(config, "voiceVolume", 0, 100)),
		popup: boolOf(config, "popup"),
		popupStyle: popupStyleOf(style),
		popupAsk: boolOf(config, "popupAsk"),
		popupPlan: boolOf(config, "popupPlan"),
		popupTaskComplete: boolOf(config, "popupTaskComplete"),
		popupRestart: boolOf(config, "popupRestart"),
		popupAwaitingTest: boolOf(config, "popupAwaitingTest"),
		popupTurnEnd: boolOf(config, "popupTurnEnd"),
		popupTurnInterrupt: boolOf(config, "popupTurnInterrupt"),
		popupTurnError: boolOf(config, "popupTurnError"),
		popupStalled: boolOf(config, "popupStalled"),
		popupTest: boolOf(config, "popupTest"),
		soundAsk: boolOf(config, "soundAsk"),
		soundPlan: boolOf(config, "soundPlan"),
		soundTaskComplete: boolOf(config, "soundTaskComplete"),
		soundRestart: boolOf(config, "soundRestart"),
		soundAwaitingTest: boolOf(config, "soundAwaitingTest"),
		soundTurnEnd: boolOf(config, "soundTurnEnd"),
		soundTurnInterrupt: boolOf(config, "soundTurnInterrupt"),
		soundTurnError: boolOf(config, "soundTurnError"),
		soundStalled: boolOf(config, "soundStalled"),
		soundTest: boolOf(config, "soundTest"),
		voiceAsk: boolOf(config, "voiceAsk"),
		voicePlan: boolOf(config, "voicePlan"),
		voiceTaskComplete: boolOf(config, "voiceTaskComplete"),
		voiceRestart: boolOf(config, "voiceRestart"),
		voiceAwaitingTest: boolOf(config, "voiceAwaitingTest"),
		voiceTurnEnd: boolOf(config, "voiceTurnEnd"),
		voiceTurnInterrupt: boolOf(config, "voiceTurnInterrupt"),
		voiceTurnError: boolOf(config, "voiceTurnError"),
		voiceStalled: boolOf(config, "voiceStalled"),
		voiceTest: boolOf(config, "voiceTest"),
		// 「待人工测试」的批次/聚合规则：范围只有两种取值，未知值一律按 all（旧行为）。
		awaitingTestScope: strOf(config, "awaitingTestScope") === "anchor" ? "anchor" : "all",
		awaitingTestAnchor: strOf(config, "awaitingTestAnchor"),
		awaitingTestQuietSeconds: numOf(config, "awaitingTestQuietSeconds", 0, 86_400),
		awaitingTestSummary: boolOf(config, "awaitingTestSummary"),
		// 严格输出协议（两态枚举）：默认模式=标签优先 + 旧判定兜底 / 严格模式=只认标签。
		// 这里是唯一一处把配置值读成枚举的地方（含历史布尔/第三态的归一化），下面只比对字符串。
		protocolMode: protocolModeOf(rawOf(config, "protocolMode")),
		throttleSeconds: numOf(config, "throttleSeconds", 0, 3600),
		askLatchSeconds: numOf(config, "askLatchSeconds", 0, 86_400),
	};
}

/** 给定 kind 该念什么：优先该 kind 自己的播报文本，留空/未知 kind 回落兜底模板。 */
function voiceTemplateFor(settings, kind) {
	const key = VOICE_TEXT_OF_KIND[kind];
	const perKind = key === undefined ? "" : String(settings[key] ?? "");
	return perKind.trim() === "" ? settings.voiceText : perKind;
}

/** 推导 <DSH_HOME>：显式环境变量优先（支持 ~ 展开），否则 per-user 默认。 */
function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.trim() !== "") {
		const expanded = env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
		return resolve(expanded);
	}
	return join(homedir(), ".dsh");
}

/** 报警资源目录。 */
function alarmDir() {
	return join(dshHome(), SUBDIR);
}

/** 诊断日志路径。 */
export function alarmLogPath() {
	return join(alarmDir(), LOG_FILE);
}

/** 追加一行 JSONL 诊断日志；任何失败都静默（诊断不能影响主流程）。 */
function note(entry) {
	try {
		const directory = alarmDir();
		mkdirSync(directory, { recursive: true });
		const path = join(directory, LOG_FILE);
		try {
			if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
		} catch {
			/* 首次写入 */
		}
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		/* ignore */
	}
}

/** ASCII-only 的 PowerShell 5.1 负载：铃声 → 语音 → 弹窗 → toast。
 *  用 String.raw 保留反斜杠；脚本里不得出现 ${...}（那是 JS 的插值）。 */
const SCRIPT_SOURCE = String.raw`param(
  [string]$Title64 = '',
  [string]$Body64 = '',
  [string]$Kind = 'test',
  [int]$Sound = 1,
  [int]$Repeats = 1,
  [string]$Wav = 'Alarm03.wav',
  [int]$Voice = 0,
  [string]$VoiceText64 = '',
  [string]$VoiceName = '',
  [int]$VoiceRate = 0,
  [int]$VoiceVolume = 100,
  [string]$PopupStyle = 'topmost',
  [int]$Toast = 1,
  [string]$LogPath = ''
)
$ErrorActionPreference = 'Continue'

function Log-Line([string]$stage, [bool]$ok, [string]$detail) {
  if ([string]::IsNullOrEmpty($LogPath)) { return }
  try {
    $logDir = Split-Path -Parent $LogPath
    if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { $null = New-Item -ItemType Directory -Force -Path $logDir }
    $record = @{
      at = (Get-Date).ToUniversalTime().ToString('o')
      ev = 'script'
      kind = $Kind
      stage = $stage
      ok = $ok
      detail = $detail
    }
    $line = $record | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  } catch { }
}

function Decode-Text([string]$b64) {
  if ([string]::IsNullOrEmpty($b64)) { return '' }
  try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) } catch { return '' }
}

$title = Decode-Text $Title64
$body = Decode-Text $Body64
if ([string]::IsNullOrEmpty($title)) { $title = 'dsh-alarm' }
if ([string]::IsNullOrEmpty($body)) { $body = 'dsh-alarm notification.' }

$style = $PopupStyle
# Two popup modes: 'topmost' = always-on-top window, 'toast' = Windows
# notification only (no window at all). Anything else -- including the 'none'
# sentinel the host passes when the popup channel is off -- means no popup.
if ($style -ne 'topmost' -and $style -ne 'toast') { $style = 'none' }
Log-Line 'start' $true ($style + '/' + $Kind)

# ---- 1) topmost window (shown FIRST so it appears instantly) -------------
# Sound playback and TTS block for several seconds; the popup must not wait.
$win = $null
if ($style -eq 'topmost') {
  try {
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase
    $win = New-Object System.Windows.Window
    $win.Title = $title
    $win.Width = 460
    $win.Height = 190
    $win.Topmost = $true
    $win.ShowInTaskbar = $true
    $win.WindowStartupLocation = 'CenterScreen'
    $win.ShowActivated = $false
    $stack = New-Object System.Windows.Controls.StackPanel
    $stack.Margin = New-Object System.Windows.Thickness(16)
    $tbTitle = New-Object System.Windows.Controls.TextBlock
    $tbTitle.Text = $title
    $tbTitle.FontSize = 16
    $tbTitle.FontWeight = 'Bold'
    $tbBody = New-Object System.Windows.Controls.TextBlock
    $tbBody.Text = $body
    $tbBody.TextWrapping = 'Wrap'
    $tbBody.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
    [void]$stack.Children.Add($tbTitle)
    [void]$stack.Children.Add($tbBody)
    $win.Content = $stack
    $win.Show()
    # Paint once right away, otherwise the window stays blank while the
    # synchronous sound / TTS calls occupy this thread.
    $win.Dispatcher.Invoke([System.Windows.Threading.DispatcherPriority]::Render, [Action]{})
    Log-Line 'popup' $true 'topmost'
  } catch {
    Log-Line 'popup' $false $_.Exception.Message
    try { if ($win) { $win.Close() } } catch { }
    $win = $null
  }
}

# ---- 2) sound ------------------------------------------------------------
if ($Sound -eq 1) {
  $played = $false
  $count = $Repeats
  if ($count -lt 1) { $count = 1 }
  if ($count -gt 5) { $count = 5 }
  # NOTE: this script must stay pure ASCII (PS 5.1 reads it in the ANSI code
  # page); Chinese text travels in the base64 parameters only.
  $wavPath = Join-Path (Join-Path $env:SystemRoot 'Media') $Wav
  try {
    if (Test-Path -LiteralPath $wavPath) {
      $player = New-Object System.Media.SoundPlayer -ArgumentList $wavPath
      for ($i = 1; $i -le $count; $i++) { $player.PlaySync() }
      $played = $true
      Log-Line 'sound' $true ($wavPath + ' x' + $count)
    } else {
      Log-Line 'sound' $false ('wav-missing: ' + $wavPath)
    }
  } catch {
    Log-Line 'sound' $false $_.Exception.Message
  }
  if (-not $played) {
    for ($i = 1; $i -le 3; $i++) {
      try { [console]::beep(1200, 400) } catch { Log-Line 'beep' $false $_.Exception.Message; break }
    }
    Log-Line 'beep' $true 'fallback'
  }
} else {
  Log-Line 'sound' $true 'disabled'
}

# ---- 3) voice (TTS) ------------------------------------------------------
if ($Voice -eq 1) {
  try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try { $synth.Rate = $VoiceRate } catch { }
    try { $synth.Volume = $VoiceVolume } catch { }
    if (-not [string]::IsNullOrEmpty($VoiceName)) {
      try { $synth.SelectVoice($VoiceName) } catch { Log-Line 'voice-select' $false $_.Exception.Message }
    }
    $spoken = Decode-Text $VoiceText64
    if ([string]::IsNullOrEmpty($spoken)) { $spoken = $title + '. ' + $body }
    $synth.Speak($spoken)
    Log-Line 'voice' $true ([string]$synth.Voice.Name)
    $synth.Dispose()
  } catch {
    Log-Line 'voice' $false $_.Exception.Message
  }
} else {
  Log-Line 'voice' $true 'disabled'
}

# ---- 4) popup tail: hold the topmost window, then close it ---------------
# 'toast' mode deliberately opens NO window: the notification in step 5 IS the
# popup channel in that mode.
$popupShown = $false
if ($style -eq 'topmost') {
  if ($win) {
    # The window is already on screen; keep it painted a few seconds, then
    # close it automatically (the Desktop is never blocked).
    $popupShown = $true
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
      try { $win.Dispatcher.Invoke([System.Windows.Threading.DispatcherPriority]::Background, [Action]{}) } catch { }
      Start-Sleep -Milliseconds 150
    }
    try { $win.Close() } catch { }
    Log-Line 'popup-close' $true 'topmost'
  }
} elseif ($style -eq 'toast') {
  Log-Line 'popup' $true 'toast-mode'
} else {
  Log-Line 'popup' $true 'disabled'
}

# ---- 5) toast (the popup channel's notification face: it is the whole
#         channel in 'toast' mode, and the fallback when no window could be
#         shown in 'topmost' mode) -----------------------------------------
if ($Toast -eq 1 -and -not $popupShown) {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    $null = $texts.Item(0).AppendChild($template.CreateTextNode($title))
    $null = $texts.Item(1).AppendChild($template.CreateTextNode($body))
    # NOTE: do NOT name this $toast -- PowerShell variables are case-insensitive,
    # so it would collide with the [int]$Toast parameter above and the
    # assignment would throw an Int32 conversion error.
    $toastObj = [Windows.UI.Notifications.ToastNotification]::new($template)
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toastObj)
    Log-Line 'toast' $true $appId
  } catch {
    Log-Line 'toast' $false $_.Exception.Message
  }
} else {
  Log-Line 'toast' $true 'disabled'
}

Log-Line 'done' $true 'ok'
`;

/** 脚本非 ASCII 字符计数（开发期护栏：PS 5.1 按 ANSI 读文件，中文会炸）。 */
export function nonAsciiCount() {
	let count = 0;
	for (const char of SCRIPT_SOURCE) if (char.codePointAt(0) > 0x7f) count += 1;
	return count;
}

/** 把报警脚本写到 <DSH_HOME>/alarm/toast-alert.ps1，返回路径（失败返回 null）。 */
export function materializeScript(logger) {
	try {
		const directory = alarmDir();
		mkdirSync(directory, { recursive: true });
		const path = join(directory, SCRIPT_FILE);
		writeFileSync(path, SCRIPT_SOURCE, "utf8");
		const bad = nonAsciiCount();
		if (bad > 0) logger?.warn?.(`dsh-alarm: 报警脚本含 ${bad} 个非 ASCII 字符，PowerShell 5.1 可能解析失败`);
		return path;
	} catch (error) {
		logger?.warn?.(`dsh-alarm: 报警脚本写入失败：${error?.message ?? error}`);
		return null;
	}
}

/** runtime root 会话的 id 列表；注册表不可用时返回 null。 */
function rootIds(ctx) {
	try {
		const roots = ctx.agents?.roots?.();
		if (!Array.isArray(roots)) return null;
		return roots.map((agent) => agent?.id).filter((id) => typeof id === "string" && id !== "");
	} catch {
		return null;
	}
}

/** 取 agent 的 id 字符串（agent 可能是 id 字符串，也可能是 { id }）；取不到返回 null。 */
function agentIdOf(agent) {
	if (typeof agent === "string" && agent !== "") return agent;
	const id = agent?.id;
	return typeof id === "string" && id !== "" ? id : null;
}

/** 给定 agent 是否属于 runtime root；无法判定时按 root 处理（宁可多提醒）。 */
function isRootAgent(ctx, agent) {
	try {
		const roots = ctx.agents?.roots?.();
		return !Array.isArray(roots) || roots.includes(agent);
	} catch {
		return true;
	}
}

/** 取 ask_user_question 的第一个问题，截断成一句话。 */
function questionSummary(exec) {
	try {
		const questions = exec?.arguments?.questions;
		if (!Array.isArray(questions) || questions.length === 0) return "";
		const first = questions[0] ?? {};
		const text =
			typeof first.question === "string" && first.question !== ""
				? first.question
				: typeof first.header === "string"
					? first.header
					: "";
		const rest = questions.length > 1 ? `（共 ${questions.length} 个问题）` : "";
		return `${String(text).slice(0, 140)}${rest}`;
	} catch {
		return "";
	}
}

/** 路径统一成「正斜杠 + 小写」（去重键与路径判定都用它，正反斜杠/大小写不影响结论）。 */
function normalizedPath(path) {
	return String(path ?? "").replaceAll("\\", "/").toLowerCase();
}

/** 是不是任务包状态文件：路径里同时出现 `03-开发协同` 与 `状态.md`。 */
function isTaskStatusPath(path) {
	const text = String(path ?? "").replaceAll("\\", "/");
	return text.includes("03-开发协同") && text.includes("状态.md");
}

/** 从 `<...>/03-开发协同/<任务名>/状态.md` 里取任务名；取不到返回 ""。 */
function taskNameOfStatusPath(path) {
	const match = /03-开发协同\/([^/]+)\/状态\.md/u.exec(String(path ?? "").replaceAll("\\", "/"));
	return match === null ? "" : match[1];
}

/** 读一个文件的「当前阶段」相位值；读不到 / 没有这一行返回 ""（绝不抛出）。 */
function phaseOfFile(path) {
	try {
		const match = PHASE_RE.exec(readFileSync(path, "utf8"));
		return match === null ? "" : match[1].trim();
	} catch {
		return "";
	}
}

/** 待测提醒的聚合/范围决策（纯函数，可单测）。
 *
 *  三项判定**按顺序**，先命中先返回：
 *   1. `scope === "anchor"` 且路径不含 `anchor`（子串匹配、不区分大小写）→ `"skip-scope"`；
 *   2. 聚合窗口内（`quietSeconds > 0` 且此前真的响过一次，且距那次不足一个窗口）→ `"pending"`；
 *   3. 其余 → `"raise"`。
 *
 *  `quietSeconds = 0`（缺省）时第 2 条恒不成立 → 行为与「没有聚合」的旧版完全一致。
 *  @returns {"raise"|"pending"|"skip-scope"}
 */
export function decideAwaitingTest({ scope, anchor, path, quietSeconds, lastRaiseAt, now }) {
	if (scope === "anchor" && !String(path ?? "").toLowerCase().includes(String(anchor ?? "").toLowerCase())) {
		return "skip-scope";
	}
	if (quietSeconds > 0 && lastRaiseAt > 0 && now - lastRaiseAt < quietSeconds * 1000) return "pending";
	return "raise";
}

/** 「待人工测试」提醒的正文（纯函数，可单测）。
 *
 *  - 待测任务 ≥2 且开着 `awaitingTestSummary` → 汇总清单（窗口结束时的那条）；
 *  - 其余情况（单个任务 / 关掉清单）→ 沿用旧文案，一字不改。
 *  @param {string[]} names - 任务名（可能含 ""，取不到名字时用「任务包」兜底）。
 *  @param {boolean} summaryOn - 是否附待测清单。
 */
export function awaitingTestBodyOf(names, summaryOn) {
	const list = (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && name !== "");
	if (summaryOn !== true || list.length < 2) {
		const name = typeof names?.[0] === "string" ? names[0] : "";
		const lead = name === "" ? "任务包已到" : `${name} 已到`;
		return `${lead}「待人工测试」，请回到 DSH 窗口实测。\n\n（dsh-alarm）`;
	}
	const lines = list.map((name) => `- ${name}`).join("\n");
	return `${list.length} 个任务待人工测试，请回到 DSH 窗口实测：\n${lines}\n\n（dsh-alarm）`;
}

/** 一次工具调用里**可能**被写到的任务状态文件路径（按规范化路径去重后的数组）。
 *  这里只负责「抽路径」，不看写入文本：文本里「提到」待人工测试不构成提醒依据，
 *  真正的依据是文件相位在写前/写后的变化（见 applyAlarm 里的 verifyAwaitingTest）。
 *  无关工具返回空数组。 */
function awaitingTestCandidates(tool, exec) {
	const args = exec?.arguments ?? {};
	const found = [];
	const push = (path) => {
		if (typeof path === "string" && path !== "" && isTaskStatusPath(path)) found.push(path);
	};
	if (tool === "write" || tool === "edit") {
		// write / edit：args.file_path 或 args.path 就是被写的那个文件。
		push(typeof args.file_path === "string" ? args.file_path : args.path);
	} else if (tool === "pwsh" || tool === "bash" || tool === "shell") {
		// 命令行工具：从命令文本里**抽路径**（命令可能用 Set-Content / Move-Item 写文件）。
		const command = typeof args.command === "string" ? args.command : "";
		if (command !== "") for (const match of command.matchAll(STATUS_PATH_IN_COMMAND_RE)) push(match[0]);
	}
	const seen = new Set();
	const unique = [];
	for (const path of found) {
		const key = normalizedPath(path);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(path);
	}
	return unique;
}

/** 从 turn/end 事件里尽力取本轮耗时（秒）；取不到返回 null。 */
function elapsedSecondsOf(event) {
	const data = event?.data ?? {};
	for (const key of ["durationMs", "elapsedMs", "duration"]) {
		const value = Number(data?.[key]);
		if (Number.isFinite(value) && value >= 0) return value > 10_000 ? value / 1000 : value;
	}
	const startedAt = data?.startedAt;
	if (startedAt !== undefined && startedAt !== null) {
		const ms = typeof startedAt === "number" ? startedAt : Date.parse(String(startedAt));
		if (Number.isFinite(ms)) return Math.max(0, (Date.now() - ms) / 1000);
	}
	return null;
}

/** session/event 里认会话用的键：与 agentIdOf() 同口径（session 可能是 id 字符串或 {id}/{header}）。 */
function sessionKeyOf(session, sessionId) {
	if (typeof sessionId === "string" && sessionId !== "") return sessionId;
	return agentIdOf(session);
}

/** 思考链 part：type 是 reasoning/thinking，或带 reasoning:true / channel:"reasoning" 标记。
 *  思考链不是回复正文（用户要求：「所有的消息判断，要忽略思考链里的消息」）。 */
function isReasoningPart(part) {
	if (part === null || typeof part !== "object") return false;
	const type = typeof part.type === "string" ? part.type : "";
	if (type === "reasoning" || type === "thinking") return true;
	return part.reasoning === true || part.channel === "reasoning";
}

/** 一条 assistant/message 记录的正文：只拼 type === "text" 的 part，并**显式跳过思考链**。
 *  返回 { text, reasoningParts }：reasoningParts 是被跳过的思考链 part 数（只进诊断日志）。
 *  思考链、tool-call 都不是「回复正文」——否则思考里提到重启就会误报。 */
function assistantTextOf(record) {
	const content = record?.data?.message?.content;
	if (!Array.isArray(content)) return { text: "", reasoningParts: 0 };
	const parts = [];
	let reasoningParts = 0;
	for (const part of content) {
		if (isReasoningPart(part)) {
			reasoningParts += 1;
			continue;
		}
		if (part?.type !== "text") continue;
		const text = typeof part.text === "string" ? part.text : "";
		if (text !== "") parts.push(text);
	}
	return { text: parts.join("\n"), reasoningParts };
}

/** 「现在就该重启 DSH 吗」的纯判定（只吃回复正文，思考链/工具调用根本到不了这里）：
 *  a. 摘掉围栏代码块（引用不算）；b. 摘掉否定说法（「现在不要重启」）；c. 摘掉未来时/条件说法
 *  （「等改完再通知你重启」）；d. 剩下的文本用 RESTART_RE 判命中。
 *  顺序即语义：先去掉「不是现在」的说法，剩下的才可能是「现在就重启」。 */
export function restartHitOf(text) {
	if (typeof text !== "string" || text === "") return false;
	const scan = text.replace(FENCED_CODE_RE, " ").replace(NEGATED_RESTART_RE, " ").replace(FUTURE_RESTART_RE, " ");
	return scan.trim() !== "" && RESTART_RE.test(scan);
}

/** 解析正文里的报警标签（严格输出协议，纯函数：不做 IO、不抛）。
 *
 *  @param {string} text - 这一轮最后一条 assistant 回复的正文。
 *  @returns {{kind: string, taskName: string}[]} 按出现顺序的标签列表；`kind` 是大写形态
 *  （`ASK` / `PLAN` / `DONE` / `RESTART` / `STALLED` / `TEST`），非 TEST 标签的 `taskName` 恒为 ""。
 *
 *  判定口径全在 `ALARM_TAG_RE` 里：区分大小写、必须独占一行（允许首尾空白）、
 *  TEST 的任务名取冒号后到 `]]` 前并 trim（可为空串）。行内出现、小写写法、缺右括号都不算。
 */
export function parseAlarmTags(text) {
	if (typeof text !== "string" || text === "") return [];
	try {
		const found = [];
		// 只许 matchAll（见 ALARM_TAG_RE 的注释：g 正则的 test/exec 会移动 lastIndex）。
		for (const match of text.matchAll(ALARM_TAG_RE)) {
			// 分组 1 对 TEST 是 `TEST:<任务名>` 整段，所以 kind 要按前缀归一回 "TEST"。
			const raw = String(match[1] ?? "");
			const isTest = raw === "TEST" || raw.startsWith("TEST:");
			found.push({
				kind: isTest ? "TEST" : raw,
				taskName: isTest ? String(match[2] ?? "").trim() : "",
			});
		}
		return found;
	} catch {
		// 纯函数不抛：正则/入参的意外一律按「没有标签」处理。
		return [];
	}
}

/** zstd 帧魔数（与 DSH 会话持久化层一致）。 */
const ZSTD_MAGIC = 0xfd2fb528;
/** 会话日志文件名（DSH 会话持久化层当前写的版本）。 */
const SESSION_LOG_FILE = "session.v4.jsonl.zstd";

/** 扫描拼接 zstd 流的帧边界（规则照 DSH 自己的会话日志扫描实现）。 */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/** 读出会话日志里的全部 JSONL 记录：zstd 拼接按帧解压，非 zstd 按纯 JSONL 解析。 */
function readSessionRecords(file) {
	const bytes = readFileSync(file);
	if (bytes.length === 0) return [];
	const records = [];
	const push = (text) => {
		for (const line of text.split("\n")) if (line.trim().length > 0) records.push(JSON.parse(line));
	};
	if (bytes.length >= 4 && bytes.readUInt32LE(0) === ZSTD_MAGIC) {
		const { frames } = scanZstdFrames(bytes);
		for (const frame of frames) push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString("utf8"));
		return records;
	}
	push(bytes.toString("utf8"));
	return records;
}

/** 按 sessionId 找会话日志文件：<DSH_HOME>/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd。
 *  遍历一级 slug 目录，存在即用；找不到返回 null。 */
function sessionLogPath(sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return null;
	const root = join(dshHome(), "sessions");
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		note({ ev: "session-file", sessionId, why: "sessions-root-unreadable" });
		return null;
	}
	for (const entry of entries) {
		if (entry.isDirectory() !== true) continue;
		const file = join(root, entry.name, sessionId, SESSION_LOG_FILE);
		try {
			if (statSync(file).isFile()) return file;
		} catch {
			/* 该 slug 目录下没有这个会话 */
		}
	}
	return null;
}

/** 兜底：从会话日志里取**最后一条** assistant/message 的正文（{ text, reasoningParts }）；
 *  没有文件/读不了返回 null。 */
function lastAssistantTextFromFile(sessionId) {
	const file = sessionLogPath(sessionId);
	if (file === null) return null;
	try {
		const records = readSessionRecords(file);
		for (let index = records.length - 1; index >= 0; index -= 1) {
			if (records[index]?.type !== "assistant/message") continue;
			return assistantTextOf(records[index]);
		}
		return { text: "", reasoningParts: 0 };
	} catch (error) {
		// 任何异常都只记日志：兜底路径失败绝不能影响其它提醒。
		note({ ev: "session-file", sessionId, why: "read-failed", error: String(error?.message ?? error) });
		return null;
	}
}

/** 这一轮最后一条回复正文：优先事件缓存，其次会话日志；两者都没有时 source = "none"。
 *  返回 { text, reasoningParts, source }（reasoningParts 只用于诊断日志）。 */
function restartHintOf(state, session, sessionId) {
	const key = sessionKeyOf(session, sessionId);
	if (key !== null) {
		const cached = state.lastAssistantText.get(key);
		if (cached !== null && typeof cached === "object") {
			// 一次即用：同一会话的第二个 turn/end 不该再拿旧正文判断。
			state.lastAssistantText.delete(key);
			return { text: cached.text, reasoningParts: cached.reasoningParts, source: "event" };
		}
	}
	const fromFile = lastAssistantTextFromFile(sessionId);
	if (fromFile === null) return { text: "", reasoningParts: 0, source: "none" };
	return { text: fromFile.text, reasoningParts: fromFile.reasoningParts, source: "file" };
}

/** 语音播报文本：把 {title} / {body} 占位符替换成真实内容。 */
function voiceTextOf(template, title, body) {
	const text = String(template ?? "").replaceAll("{title}", title).replaceAll("{body}", body);
	return text.trim() === "" ? "" : text;
}

/** 网络音色失败后的熔断时长：这段时间内，用户选的仍是网络音色时直接用本机离线音色，
 *  不再先静默失败一次（过期后恢复用户原选择）。 */
const VOICE_DOWN_MS = 10 * 60 * 1000;
/** 子进程输出累计上限（只为事后判定「语音有没有真的念出来」，不解析别的）。 */
const OUTPUT_CAP = 8 * 1024;
/** 「语音没念出来」的输出指纹：VoiceGardenSAPI / RustTts 把错误写成一行 [warning]，
 *  而 `SpeechSynthesizer.Speak()` 本身不抛异常，所以「进程正常退出」证明不了「念出来了」。 */
const VOICE_FAIL_RE = /Speak failed|RustTts.{0,40}(fail|error)|403 Forbidden/i;
/** 诊断日志里存命中的那一行原文，长度上限。 */
const VOICE_FAIL_LINE_MAX = 200;

/** 从脚本累计输出里挑出「语音失败」的那一行原文；没有命中返回 null。 */
function voiceFailureLine(output) {
	const text = String(output ?? "");
	if (text === "" || !VOICE_FAIL_RE.test(text)) return null;
	const hit = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line !== "" && VOICE_FAIL_RE.test(line));
	const picked = hit ?? text.trim();
	return picked.length > VOICE_FAIL_LINE_MAX ? `${picked.slice(0, VOICE_FAIL_LINE_MAX)}…` : picked;
}

/** 一次提醒的组装与节流，然后交给 detached powershell。永不抛出、永不 await。
 *  @param {object} ctx - 宿主 context。
 *  @param {object} state - 插件内共享的节流状态。
 *  @param {string|null} scriptPath - 已落盘的 .ps1 路径。
 *  @param {object} settings - settingsOf(config) 的结果（调用时现读）。
 *  @param {string} kind - ask / plan / task-complete / turn-end / turn-interrupt / turn-error / test / awaiting-test / restart。
 *  @param {string} title - 标题（中文，走 base64）。
 *  @param {string} body - 正文（中文，走 base64）。
 *  @param {number|null} elapsedSeconds - 本轮耗时（仅 turn-end 用）。
 *  @returns {boolean} 是否真的投递（被开关/节流拦下时为 false）。
 */
function raise(ctx, state, scriptPath, settings, kind, title, body, elapsedSeconds = null) {
	const now = Date.now();
	if (!settings.enabled) {
		note({ ev: "skip", kind, why: "disabled" });
		return false;
	}
	if (kind === "ask" && !settings.alertAsk) {
		note({ ev: "skip", kind, why: "alertAsk-off" });
		return false;
	}
	// 每种 kind 一个开关（test 也有自己的 alertTest；关掉后走同一条 skip 分支）。
	const switchKey = SWITCH_OF_KIND[kind];
	if (switchKey !== undefined && settings[switchKey] === false) {
		note({ ev: "skip", kind, why: `${switchKey}-off` });
		return false;
	}
	if (
		kind === "turn-end" &&
		settings.minTurnSeconds > 0 &&
		typeof elapsedSeconds === "number" &&
		elapsedSeconds < settings.minTurnSeconds
	) {
		note({ ev: "skip", kind, why: "turn-too-short", elapsedSeconds, minTurnSeconds: settings.minTurnSeconds });
		return false;
	}

	const gapMs = settings.throttleSeconds * 1000;
	const last = state.lastAt.get(kind) ?? 0;
	if (gapMs > 0 && now - last < gapMs) {
		note({ ev: "skip", kind, why: "throttle", gapMs });
		return false;
	}
	// 「裁决 / 确认计划」之后紧接着的收尾（turn-end / task-complete）是同一件事，只响一次。
	if (
		(kind === "turn-end" || kind === "task-complete") &&
		now - state.lastAskAt < settings.askLatchSeconds * 1000
	) {
		note({ ev: "skip", kind, why: "ask-latch", latchMs: settings.askLatchSeconds * 1000 });
		return false;
	}
	state.lastAt.set(kind, now);
	if (kind === "ask" || kind === "plan") state.lastAskAt = now;

	// 通道判定（三条各自独立，每条都要过「通道总开关 ∧ 该条件开关」两道）：
	//   弹窗 = 弹窗总开关 popup ∧ 该条件的 popup<Kind> ∧ popupStyle ∈ {topmost, toast}
	//          （两种模式都算「弹窗通道开着」，只是呈现不同：置顶窗口 / 系统通知）
	//   toast = 与弹窗同口径（弹窗通道的兜底子通道，不单独设开关；popupStyle="toast"
	//           时它就是弹窗通道本身，popupStyle="topmost" 时是窗口没弹出来时的兜底）
	//   铃声 = 铃声总开关 soundEnabled ∧ 该条件的 sound<Kind>
	//   语音播报 = 语音播报总开关 voice ∧ 该条件的 voice<Kind> ∧ 播报文本非空
	// 语音文本**按 kind** 取：该 kind 自己的 voiceTextAsk / voiceTextTurnEnd / …；
	// 留空或未知 kind 时回落到兜底模板 voiceText。
	const perKindOn = (prefix) => {
		const suffix = CHANNEL_SUFFIX_OF_KIND[kind];
		return suffix === undefined ? true : settings[`${prefix}${suffix}`] === true;
	};
	const voiceTemplate = voiceTemplateFor(settings, kind);
	const spoken = voiceTextOf(voiceTemplate, title, body);
	const popupOn =
		settings.popup === true &&
		perKindOn("popup") &&
		(settings.popupStyle === "topmost" || settings.popupStyle === "toast");
	// toast 不是第四条通道：它是弹窗通道的兜底子通道（窗口没弹出来时补一条系统通知）。
	// 所以口径与 popupOn 完全一致——弹窗总开关关掉时 toast 也不发（否则用户眼里
	// 「关了弹窗」仍然会看到右下角报警通知）。
	const toastOn = popupOn;
	const soundOn = settings.soundEnabled === true && perKindOn("sound");
	const voiceOn = settings.voice === true && perKindOn("voice") && spoken !== "";
	// 三条通道全关：不起子进程（省一次进程），但留一条日志说明「条件命中、三条都关」。
	if (!popupOn && !soundOn && !voiceOn) {
		note({ ev: "raise-suppressed", kind, why: "all-channels-off", popupOn, soundOn, voiceOn });
		return false;
	}

	note({
		at: new Date().toISOString(),
		ev: "raise",
		kind,
		title,
		body,
		elapsedSeconds,
		popupOn,
		toastOn,
		soundOn,
		voiceOn,
		sound: soundOn ? `${settings.sound} x${settings.soundRepeats}` : "off",
		voice: voiceOn,
		voiceTemplate: voiceOn ? voiceTemplate : null,
		popup: popupOn ? settings.popupStyle : "none",
		scriptPath,
	});
	if (scriptPath === null) return false;

	const base64 = (value) => Buffer.from(String(value ?? ""), "utf8").toString("base64");
	try {
		const logPath = alarmLogPath();
		const popupStyle = popupOn ? settings.popupStyle : "none";
		const title64 = base64(title);
		const body64 = base64(body);
		const voiceText64 = base64(voiceOn ? spoken : "");
		// 熔断期内（上次网络音色失败后的 10 分钟内）且用户选的仍是网络音色：
		// 首次就直接用本机离线音色，省掉「先静默失败一次」的那一遍。
		let voiceName = settings.voiceName;
		if (voiceOn === true && Date.now() < (state.voiceDownUntil ?? 0) && isNetworkVoice(voiceName)) {
			voiceName = pickOfflineVoice(listInstalledVoices(ctx?.logger));
			note({ ev: "voice-circuit", kind, voice: voiceName });
		}
		/** 组一次脚本参数。回退重放时只留语音通道（铃声/弹窗/toast 全关），别的通道不再做一遍。 */
		const argsFor = (channels) => [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-WindowStyle",
			"Hidden",
			"-File",
			scriptPath,
			"-Title64",
			title64,
			"-Body64",
			body64,
			"-Kind",
			kind,
			"-Sound",
			channels.sound ? "1" : "0",
			"-Repeats",
			String(settings.soundRepeats),
			"-Wav",
			settings.sound,
			"-Voice",
			channels.voice ? "1" : "0",
			"-VoiceText64",
			voiceText64,
			"-VoiceName",
			channels.voiceName,
			"-VoiceRate",
			String(settings.voiceRate),
			"-VoiceVolume",
			String(settings.voiceVolume),
			"-PopupStyle",
			channels.popup ? popupStyle : "none",
			"-Toast",
			channels.toast ? "1" : "0",
			"-LogPath",
			logPath,
		];
		/** 起一次脚本进程。输出必须接出来：网络音色失败只写 stderr
		 *  （`[warning] RustTts::Engine::Speak failed: ... 403 Forbidden`），而
		 *  `Speak()` 不抛异常，所以「进程正常退出」证明不了「真的念出来了」。 */
		const launch = (name, canRetry, voiceOnly = false) => {
			const child = spawn(
				"powershell.exe",
				argsFor(
					// 回退重放只念语音：铃声/弹窗/toast 全部关掉，别的通道不再做一遍。
					voiceOnly
						? { sound: false, popup: false, toast: false, voice: true, voiceName: name }
						: { sound: soundOn, popup: popupOn, toast: toastOn, voice: voiceOn, voiceName: name },
				),
				// 不能加 detached: true —— DSH 宿主进程约在 Job 对象里，
				// 带 CREATE_NEW_PROCESS_GROUP 的子进程会静默不执行（实测 4 种组合里
				// 只有非 detached 的能真正跑起来）。这里子进程短命，父进程常驻即可。
				{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
			);
			let output = "";
			const take = (chunk) => {
				if (output.length >= OUTPUT_CAP) return;
				output += String(chunk);
				if (output.length > OUTPUT_CAP) output = output.slice(0, OUTPUT_CAP);
			};
			child.stdout?.setEncoding?.("utf8");
			child.stderr?.setEncoding?.("utf8");
			child.stdout?.on("data", take);
			child.stderr?.on("data", take);
			child.on("error", (error) => {
				ctx?.logger?.warn?.(`dsh-alarm: 报警进程启动失败：${error?.message ?? error}`);
				note({ ev: "spawn-error", kind, error: String(error?.message ?? error) });
			});
			// 退出后复核输出：命中「语音失败」指纹就如实记一笔（不再记成 ok），并**只重试一次**——
			// 用本机离线音色把这条提醒念出来。回退语音与刚失败的是同一个（熔断期已直接用它）时
			// 不再起进程，避免成环。
			child.on("close", () => {
				if (voiceOn !== true) return;
				const why = voiceFailureLine(output);
				if (why === null) return;
				const fallback = pickOfflineVoice(listInstalledVoices(ctx?.logger));
				const downUntil = Date.now() + VOICE_DOWN_MS;
				state.voiceDownUntil = downUntil;
				note({
					ev: "voice-fallback",
					kind,
					why,
					from: name,
					to: fallback,
					downUntil: new Date(downUntil).toISOString(),
				});
				if (canRetry !== true || fallback === name) return;
				const retry = launch(fallback, false, true);
				note({ ev: "voice-fallback-spawn", kind, pid: retry?.pid ?? null, voice: fallback });
			});
			note({ ev: "spawn", kind, pid: child.pid ?? null });
			child.unref();
			return child;
		};
		launch(voiceName, true);
		return true;
	} catch (error) {
		ctx?.logger?.warn?.(`dsh-alarm: 报警投递失败：${error?.message ?? error}`);
		note({ ev: "spawn-error", kind, error: String(error?.message ?? error) });
		return false;
	}
}

/** 设置页「条件表逐行试听」用：按当前设置模拟一次该行的真机提醒。
 *  @param {object} ctx - 宿主 context。
 *  @param {object} config - 插件 config（试听时现读）。
 *  @param {string} [kind="test"] - TEST_KINDS 之一；非法/缺省一律按 "test"。
 *
 *  试听口径 =「按当前设置模拟该行」：报警总开关 `enabled`、该行的 alert<Kind> /
 *  popup<Kind> / sound<Kind> / voice<Kind> 开关、三条通道总开关、popupStyle、铃声文件与
 *  播报文本**全部沿用当前设置**——试听完全按当前设置模拟：报警总开关关着就不响。
 *  试听与真实提醒的差别只有节流三项被清零，其余设置一律照用：
 *    throttleSeconds / askLatchSeconds / minTurnSeconds: 0（去节流、去去重锁、去最短时长，
 *    这样连点每次都能真有反应，不必等节流窗口）
 *  @returns {boolean} raise() 的 delivered（被总开关、该行开关或通道开关拦下时为 false）。
 */
export function testAlert(ctx, config, kind = "test") {
	const settings = settingsOf(config);
	const scriptPath = materializeScript(ctx?.logger);
	const state = { lastAt: new Map(), lastAskAt: 0 };
	const kindOf = TEST_KINDS.includes(kind) ? kind : "test";
	const message = TEST_MESSAGE_OF_KIND[kindOf];
	note({ ev: "test", scriptPath, kind: kindOf });
	return raise(
		ctx,
		state,
		scriptPath,
		{ ...settings, throttleSeconds: 0, askLatchSeconds: 0, minTurnSeconds: 0 },
		kindOf,
		message.title,
		message.body,
		null,
	);
}

/** 挂载报警层。 */
export function applyAlarm(ctx, config) {
	// 启动/热重载标记：宿主重启与 HMR 重载都会打这一行，便于确认「新代码已经进来了」。
	note({ ev: "apply", ns: "dsh-alarm", at: new Date().toISOString(), pid: process.pid });
	/** 节流状态 + 每轮起始时间（sessionId → ms）+ 本轮已发完成提醒。
	 *  completedTurnSent 里装的都是 agent id（root 会话的 session id 即 agent id）：
	 *  update_goal(complete) 已响过「全部任务完成」后，同轮的 idle 兜底不再重复响。 */
	const state = {
		lastAt: new Map(),
		lastAskAt: 0,
		turnStart: new Map(),
		completedTurnSent: new Set(),
		/** 任务状态文件路径（规范化）→ 上次「待人工测试」提醒的 ms。 */
		awaitingTestAt: new Map(),
		/** 任务状态文件路径（规范化）→ **写前**读到的「当前阶段」相位（写后校验用）。
		 *  条目很小（每项目几十个状态文件），不主动清理：verify 需要它，
		 *  提前删掉会让晚到的 verify 把「相位没变」误判成变化。 */
		phaseBefore: new Map(),
		/** 会话 id → 这一轮最后一条 assistant 回复正文 { text, reasoningParts }（turn/end 时消费一次）。 */
		lastAssistantText: new Map(),
		/** 聚合窗口内还没响的待测任务：规范化路径 / 任务名 → 任务名（窗口结束时汇总成一条）。 */
		awaitingTestPending: new Map(),
		/** 上一次**真的投递**了「待人工测试」的时刻（聚合窗口起点；0 = 本轮还没响过）。 */
		awaitingTestLastRaiseAt: 0,
		/** 窗口结束时汇总的那一个定时器句柄（null = 没有待汇总项）。 */
		awaitingTestTimer: null,
		/** 会话 id → 本轮的**工具调用**次数（stalled 判定的输入；turn/start 清零、turn/end 读后清零）。 */
		turnToolCalls: new Map(),
		/** 本轮调用过 ask_user_question / exit_plan_mode 的会话（已经请你裁决过 → 不算停住）。 */
		askPlanTurn: new Set(),
		/** 会话 id → 该会话的 goal 是否活跃（update_goal 跟踪：complete → false，其余 action → true）。 */
		goalActive: new Map(),
		/** 会话 id → 上次「停住」提醒的 ms（同一 agent 10 分钟内只响一次）。 */
		stalledAt: new Map(),
	};
	let scriptPath = null;
	const prepare = () => (scriptPath ??= materializeScript(ctx?.logger));
	const settings = () => settingsOf(config);

	/** 聚合窗口结束：把窗口内攒下的待测任务合成一条提醒（定时器回调，绝不抛到宿主）。
	 *  标题仍是「任务到「待人工测试」」，正文见 awaitingTestBodyOf：≥2 个任务时列清单。 */
	const flushAwaitingTest = () => {
		state.awaitingTestTimer = null;
		try {
			if (state.awaitingTestPending.size === 0) return;
			const entries = [...state.awaitingTestPending.entries()];
			state.awaitingTestPending.clear();
			const current = settings();
			const now = Date.now();
			const delivered = raise(
				ctx,
				state,
				prepare(),
				current,
				"awaiting-test",
				"任务到「待人工测试」",
				awaitingTestBodyOf(
					entries.map(([, name]) => name),
					current.awaitingTestSummary,
				),
			);
			note({ ev: "flush", kind: "awaiting-test", count: entries.length, delivered });
			// 没投递成功（总开关/条件开关/节流拦下）就只清 pending，不写去重与窗口起点。
			if (!delivered) return;
			state.awaitingTestLastRaiseAt = now;
			// 只有真的投递了才写去重时间戳（与单条投递同口径）。
			for (const [key] of entries) state.awaitingTestAt.set(key, now);
		} catch (error) {
			note({ ev: "flush-error", kind: "awaiting-test", error: String(error?.message ?? error) });
		}
	};

	/** 「待人工测试」的公共一段：开关 → 同键 5 分钟去重 → 批次/聚合决策（decideAwaitingTest）
	 *  → 立即投递 / 攒进窗口。
	 *
	 *  **状态文件通道与正文标签通道共用这一段**：两条通道的差别只有「key 与用于锚点匹配的
	 *  文本」——状态文件通道用规范化路径（`03-开发协同/<任务>/状态.md`），正文标签通道用
	 *  **任务名**（`[[ALARM:TEST:<任务名>]]` 里那两个冒号之间的部分）。其余约束
	 *  （alertAwaitingTest / 5 分钟去重 / 聚合窗口 / 汇总清单 / 节流）完全一致，不要在这里
	 *  为某一条通道开特例。
	 *
	 *  @param {{key: string, taskName: string, scopePath: string, extra: object}} input
	 *    key＝去重键；scopePath＝`awaitingTestScope === "anchor"` 时做子串匹配的文本；
	 *    extra＝并入诊断日志的定位字段（path/phase/taskName…）。
	 *  @returns {"raised"|"pending"|"dedup"|"off"|"skip-scope"|"suppressed"}
	 */
	const dispatchAwaitingTest = ({ key, taskName, scopePath, extra }) => {
		const now = Date.now();
		const current = settings();
		if (current.alertAwaitingTest !== true) {
			note({ ev: "skip", kind: "awaiting-test", why: "off", ...extra });
			return "off";
		}
		const last = state.awaitingTestAt.get(key) ?? 0;
		if (now - last < AWAITING_TEST_DEDUPE_MS) {
			note({ ev: "skip", kind: "awaiting-test", why: "dedup", ...extra });
			return "dedup";
		}
		// 批次/聚合决策（纯函数）：范围过滤 → 窗口内累积 → 立即投递。
		// 向后兼容：scope=all 且 quietSeconds=0 时恒为 "raise"，与旧版行为完全一致。
		const decision = decideAwaitingTest({
			scope: current.awaitingTestScope,
			anchor: current.awaitingTestAnchor,
			path: scopePath,
			quietSeconds: current.awaitingTestQuietSeconds,
			lastRaiseAt: state.awaitingTestLastRaiseAt,
			now,
		});
		if (decision === "skip-scope") {
			note({ ev: "skip", kind: "awaiting-test", why: "out-of-scope", anchor: current.awaitingTestAnchor, ...extra });
			return "skip-scope";
		}
		if (decision === "pending") {
			// 窗口内不再响：先攒起来，窗口结束时由 flushAwaitingTest 汇总成一条。
			state.awaitingTestPending.set(key, taskName);
			note({ ev: "skip", kind: "awaiting-test", why: "quiet-pending", ...extra });
			if (state.awaitingTestTimer === null) {
				// 只等「窗口剩余时间」：窗口从那次真的响了的时刻起算。
				const waitMs = Math.max(
					0,
					current.awaitingTestQuietSeconds * 1000 - (now - state.awaitingTestLastRaiseAt),
				);
				state.awaitingTestTimer = setTimeout(flushAwaitingTest, waitMs);
			}
			return "pending";
		}
		const delivered = raise(
			ctx,
			state,
			prepare(),
			current,
			"awaiting-test",
			"任务到「待人工测试」",
			awaitingTestBodyOf([taskName], current.awaitingTestSummary),
		);
		// 被 alertAwaitingTest 拦下时不记时间戳（保持 skip 语义，下次仍会尝试）。
		if (!delivered) return "suppressed";
		state.awaitingTestAt.set(key, now);
		// 窗口起点 = 这次真的响了的时刻；攒着的待测项随之清空（下一窗口从零开始攒）。
		state.awaitingTestLastRaiseAt = now;
		state.awaitingTestPending.clear();
		return "raised";
	};

	/** 正文标签通道：`[[ALARM:TEST:<任务名>]]` 直接按「待人工测试」响。
	 *  去重键与聚合 key 都是**任务名**（状态文件通道用的是规范化路径），其余全部复用
	 *  `dispatchAwaitingTest`——包括 alertAwaitingTest、5 分钟同键去重、聚合窗口与汇总清单。 */
	const raiseAwaitingTestTag = (taskName, sessionId) => {
		const name = String(taskName ?? "").trim();
		const outcome = dispatchAwaitingTest({
			key: normalizedPath(name),
			taskName: name,
			scopePath: name,
			extra: { source: "tag", taskName: name, sessionId },
		});
		note({ ev: "tag", kind: "TEST", taskName: name, outcome, sessionId });
	};

	/** kind `stalled`「Agent 停下来且没有后续动作」：两条触发路径（正文 `[[ALARM:STALLED]]`
	 *  标签 / turn/end 的启发式判定）共用这一个投递口，正文与开关完全一致。
	 *  `stalledAt` 在这里落戳：不管通道开关是否让这次真的响，同一 agent 10 分钟内不再试。 */
	const raiseStalled = (why, sessionId) => {
		if (typeof sessionId === "string") state.stalledAt.set(sessionId, Date.now());
		const delivered = raise(
			ctx,
			state,
			prepare(),
			settings(),
			"stalled",
			"Agent 停下来且没有后续动作",
			"这一轮没有工具调用也没有请你裁决，可能已经停住；如需继续请回一句。\n\n（dsh-alarm）",
		);
		note({ ev: "stalled", why, sessionId, delivered });
		return delivered;
	};

	/** 写后校验：该状态文件的「当前阶段」是否**真的**从别的值变成了「待人工测试」。
	 *  定时器回调（setTimeout），绝不抛到宿主：整段 try/catch，异常只记日志。
	 *  判定：newPhase === 待人工测试 且 oldPhase !== 待人工测试 才往下走；
	 *  再过既有的 5 分钟同路径去重（只有真的投递了才写时间戳）；
	 *  最后过批次/聚合决策（decideAwaitingTest）：范围过滤 → 窗口内累积 → 立即投递。 */
	const verifyAwaitingTest = (tool, candidates, root) => {
		try {
			for (const path of candidates) {
				const key = normalizedPath(path);
				const phaseBefore = state.phaseBefore.get(key) ?? "";
				const phaseAfter = phaseOfFile(path);
				note({ ev: "verify", kind: "awaiting-test", tool, path, phaseBefore, phaseAfter, root });
				if (phaseAfter !== AWAITING_PHASE) {
					note({ ev: "skip", kind: "awaiting-test", why: "not-awaiting", path, phaseBefore, phaseAfter });
					continue;
				}
				if (phaseBefore === AWAITING_PHASE) {
					// 写前就已经是「待人工测试」：同值重写（追加日志、改别的字段）不算推进。
					note({ ev: "skip", kind: "awaiting-test", why: "no-change", path, phaseBefore, phaseAfter });
					continue;
				}
				if (!root) {
					note({ ev: "skip", kind: "awaiting-test", why: "not-root-session", path, phaseBefore, phaseAfter });
					continue;
				}
				// 开关 / 同路径去重 / 批次聚合 / 投递全部在公共一段里（正文标签通道共用）。
				dispatchAwaitingTest({
					key,
					taskName: taskNameOfStatusPath(path),
					scopePath: path,
					extra: { path, phaseBefore, phaseAfter },
				});
			}
		} catch (error) {
			note({ ev: "verify-error", kind: "awaiting-test", error: String(error?.message ?? error) });
			ctx.logger?.warn?.(`dsh-alarm: 待人工测试校验失败：${error?.message ?? error}`);
		}
	};

	ctx.on("tools/pre-execute", (exec, next) => {
		try {
			const tool = exec?.name;
			const agentId = agentIdOf(exec?.agent);
			const action = tool === "update_goal" ? exec?.arguments?.action : undefined;

			// 0) 每轮计数器：stalled 判定要「这一轮没有任何工具调用、也没有请你裁决」。
			//    计数在 turn/start 清零、turn/end 读后清零；ask/plan 另记一个标记
			//    （ask_user_question / exit_plan_mode 本身也算工具调用，但语义上要单独排掉）。
			if (agentId !== null) state.turnToolCalls.set(agentId, (state.turnToolCalls.get(agentId) ?? 0) + 1);
			if (agentId !== null && TOOL_KINDS.has(tool)) state.askPlanTurn.add(agentId);
			// goal 跟踪：stalled 只在「该会话确实有活跃 goal」时才响。
			// `complete` → 完成；create/edit/resume/pause（以及其它任何 action）→ 活跃；
			// 从未调用过 update_goal 的会话**不进这张表** → 未知 → 不响。
			if (agentId !== null && tool === "update_goal" && typeof action === "string") {
				state.goalActive.set(agentId, action !== "complete");
			}

			// 1) 任务包被推进到「待人工测试」：只在**状态文件真的变了**时才响。
			//    判定链：抽候选路径 → 写前同步读旧相位（state.phaseBefore）→ 工具执行
			//    （末尾仍然 return next()，绝不吞掉工具调用）→ AWAITING_TEST_VERIFY_MS 后
			//    复读校验：仅当 newPhase === 待人工测试 且 oldPhase !== 待人工测试 才 raise。
			//    入参文本（content / new_string / 整条 command）一律不参与判定：命令里
			//    顺带提到状态文件路径与「当前阶段：待人工测试」不再误报。
			//    严格输出协议：只有 `tag-only`（严格模式）把这条通道**整条关闭**（不抽路径、
			//    不排复核定时器）；其余一律（默认模式 `tag-first`，以及被归一化过来的历史值）
			//    照常监视状态文件相位。
			const strictTagOnly = settings().protocolMode === "tag-only";
			const candidates = strictTagOnly ? [] : awaitingTestCandidates(tool, exec);
			if (candidates.length > 0) {
				const root = isRootAgent(ctx, exec?.agent);
				for (const path of candidates) state.phaseBefore.set(normalizedPath(path), phaseOfFile(path));
				note({
					ev: "tool",
					tool,
					awaitingTest: true,
					path: candidates.join(" | "),
					phaseBefore: candidates.map((path) => state.phaseBefore.get(normalizedPath(path))),
					root,
				});
				setTimeout(() => verifyAwaitingTest(tool, candidates, root), AWAITING_TEST_VERIFY_MS);
			}

			const toolKind = TOOL_KINDS.get(tool);
			if (action === "complete" || toolKind !== undefined) {
				const root = isRootAgent(ctx, exec?.agent);
				const current = settings();
				note({ ev: "tool", tool, root, action, enabled: current.enabled });
				if (root) {
					if (action === "complete") {
						// 「全部任务完成」的**唯一**入口：update_goal(complete) 当场就响，
						// 不等 turn/end（普通轮次结束不报完成）。同轮的 idle 兜底靠
						// completedTurnSent 去重，不会连响两次。
						if (agentId !== null) state.completedTurnSent.add(agentId);
						raise(
							ctx,
							state,
							prepare(),
							current,
							"task-complete",
							"全部任务完成",
							"Agent 报告全部任务已完成，请回到 DSH 窗口查看结果。\n\n（dsh-alarm）",
						);
					} else {
						const ask = toolKind === "ask";
						const detail = ask ? questionSummary(exec) : "";
						raise(
							ctx,
							state,
							prepare(),
							current,
							toolKind,
							ask ? "需要你的裁决" : "需要你确认计划",
							`${detail !== "" ? detail : ask ? "Agent 停下来等你做选择。" : "Agent 提交了计划，等你确认。"}\n\n请回到 DSH 窗口处理。（dsh-alarm）`,
						);
					}
				}
			}
		} catch (error) {
			ctx.logger?.warn?.(`dsh-alarm: 工具提醒失败：${error?.message ?? error}`);
		}
		return next();
	});

	ctx.on("session/event", (session, event) => {
		try {
			const sessionId = session?.id ?? session?.header?.id ?? null;
			// 记下每轮起点，turn/end 时算耗时（minTurnSeconds 依赖它）。
			if (event?.type === "turn/start" && typeof sessionId === "string") {
				state.turnStart.set(sessionId, Date.now());
				state.completedTurnSent.delete(sessionId);
				// 新一轮开始：本轮的工具调用计数与 ask/plan 标记一律清零（stalled 逐轮口径）。
				state.turnToolCalls.set(sessionId, 0);
				state.askPlanTurn.delete(sessionId);
				// 新一轮开始：上一轮留下的正文不能再用（「这一轮最后一条回复」是逐轮口径）。
				const stale = sessionKeyOf(session, sessionId);
				if (stale !== null) state.lastAssistantText.delete(stale);
				return;
			}
			// 记下这一轮最后一条回复正文：turn/end 时用它判断「是否要提醒重启 DSH」。
			// 只拼 text part，思考链（reasoning/thinking）与 tool-call 不算回复正文。
			if (event?.type === "assistant/message") {
				const key = sessionKeyOf(session, sessionId);
				if (key !== null) state.lastAssistantText.set(key, assistantTextOf(event));
				return;
			}
			if (event?.type !== "turn/end") return;

			const measured = elapsedSecondsOf(event);
			const startedAt = typeof sessionId === "string" ? state.turnStart.get(sessionId) : undefined;
			if (typeof sessionId === "string") state.turnStart.delete(sessionId);
			const elapsedSeconds =
				measured ?? (typeof startedAt === "number" ? Math.max(0, (Date.now() - startedAt) / 1000) : null);
			// 本轮的计数与标记：**先读到局部变量再立刻清零**——turn/end 有多条提前 return 的
			// 分支，留在 Map 里会把「上一轮有工具调用」带进下一轮的 stalled 判定。
			const toolCalls = typeof sessionId === "string" ? (state.turnToolCalls.get(sessionId) ?? 0) : 0;
			const askedThisTurn = typeof sessionId === "string" && state.askPlanTurn.has(sessionId);
			if (typeof sessionId === "string") {
				state.turnToolCalls.delete(sessionId);
				state.askPlanTurn.delete(sessionId);
			}

			const roots = rootIds(ctx);
			const reason = event?.data?.reason?.kind ?? "completed";
			const current = settings();
			note({ ev: "turn/end", sessionId, roots, reason, elapsedSeconds, minTurnSeconds: current.minTurnSeconds });
			if (roots !== null && typeof sessionId === "string" && !roots.includes(sessionId)) {
				note({ ev: "skip", kind: "turn-end", why: "not-root-session" });
				return;
			}
			const done = reason === "completed";
			if (!done) {
				// 非正常收尾再分两类：手动打断（abort / interrupt / cancel / stop / user）
				// 与异常报错（error / failed / max-tokens / 其它未知值）。原始 reason 留在
				// 日志里，便于日后按真实事件校准这条正则。
				const interrupted = INTERRUPT_RE.test(reason);
				const kind = interrupted ? "turn-interrupt" : "turn-error";
				note({ ev: "turn/classify", kind, reason, interrupted });
				raise(
					ctx,
					state,
					prepare(),
					current,
					kind,
					interrupted ? `本轮中断（${reason}）` : `本轮报错（${reason}）`,
					interrupted
						? "这一轮被手动打断了，请回到 DSH 窗口查看进度。\n\n（dsh-alarm）"
						: "这一轮没有正常收尾，请回到 DSH 窗口查看原因。\n\n（dsh-alarm）",
					elapsedSeconds,
				);
				return;
			}
			// 正常收尾。判定顺序（先命中先返回，每一类每轮只处理一次）：
			//   1) 正文标签 `[[ALARM:RESTART]]` 和/或（默认模式下）正文正则 → restart；
			//   2) 正文标签 `[[ALARM:TEST:<任务名>]]` → awaiting-test；
			//   3) 正文标签 `[[ALARM:STALLED]]` → stalled；
			//   4) 启发式：本轮没有工具调用 / 没请过裁决 / 有活跃 goal → stalled；
			//   5) 其余 → 本轮结束。
			const hint = restartHintOf(state, session, sessionId);
			const restartOn = current.alertRestart === true;
			// 正文标签通道（严格输出协议）：纯函数解析，行内出现 / 大小写不对都不算。
			const tags = parseAlarmTags(hint.text);
			const tagKinds = new Set(tags.map((tag) => tag.kind));
			// ASK / PLAN / DONE 只记一条日志：对应事件已经由工具调用触发过，标签只是给人看的
			// 可读副本（不额外做事，但留痕便于排查）。
			for (const kind of ["ASK", "PLAN", "DONE"]) {
				if (tagKinds.has(kind)) note({ ev: "tag", kind, sessionId });
			}
			// 两态语义（与文件头第 8 条一致）：
			//   tag-first（默认模式）——标签优先，**没命中标签时用旧判定兜底**（RESTART 标签缺席 →
			//     正文正则 restartHitOf 仍参与；TEST 标签缺席 → 状态文件监视仍在 pre-execute 里跑）；
			//   tag-only（严格模式）——只认标签，正文正则不参与。
			// 两种通道同时命中（标签 + 正文措辞）时只响一次：下面 raise 后立即 return。
			const restartMode = current.protocolMode;
			const strictTagOnly = restartMode === "tag-only";
			const tagRestartHit = tagKinds.has("RESTART");
			const textRestartHit = strictTagOnly !== true && restartHitOf(hint.text);
			const restartHit = tagRestartHit || textRestartHit;
			// 诊断日志：重启后能直接从这里看出「正文从哪来、跳过几条思考链、命中没命中、有哪些标签」。
			note({
				ev: "assistant/text",
				sessionId,
				chars: hint.text.length,
				reasoningParts: hint.reasoningParts,
				source: hint.source,
				protocolMode: restartMode,
				tags: tags.map((tag) => tag.kind),
				tagRestart: tagRestartHit,
				textRestart: textRestartHit,
				hit: restartHit,
				restart: restartOn && restartHit,
			});
			if (restartOn && restartHit) {
				raise(
					ctx,
					state,
					prepare(),
					current,
					"restart",
					"需要重启 DSH",
					"agent 报告这次改动需要重启 DSH 才生效，请重启后继续。\n\n（dsh-alarm）",
					elapsedSeconds,
				);
				return;
			}
			// 没命中（或 alertRestart 关掉）：原因留在日志里，继续看后面的通道。
			note({ ev: "skip", kind: "restart", why: restartOn ? "no-restart-hint" : "alertRestart-off" });
			// 正文标签 `[[ALARM:TEST:<任务名>]]` → 立即按「待人工测试」响。
			// 去重键与聚合 key 都换成**任务名**，其余约束（alertAwaitingTest / 5 分钟去重 /
			// 聚合窗口 / 汇总清单 / 节流）与状态文件通道完全一致。
			// 两种模式**都认**这条标签（严格模式就是「只认标签」，默认模式是「标签优先」）。
			const testTag = tags.find((tag) => tag.kind === "TEST");
			if (testTag !== undefined) {
				raiseAwaitingTestTag(testTag.taskName, sessionId);
				return;
			}
			// 正文标签 `[[ALARM:STALLED]]` → agent 自己说它停住了，不必再判启发式条件。
			// **不受 protocolMode 控制**：它与下面的启发式一直是并列的两条通道（旧版
			// protocolMode 也只关「重启正则」与「状态文件监视」两条，别顺手把它删掉）。
			if (tagKinds.has("STALLED")) {
				raiseStalled("tag", sessionId);
				return;
			}
			// 启发式「停住」：这一轮没有任何工具调用、没有请你裁决、该会话**确实有活跃 goal**
			// （`complete` → false；从未见过 update_goal → 未知 → 不响），且同一 agent
			// 10 分钟内没响过。重启/待测已在上面的分支返回，所以 stalled 天然排在它们之后。
			const goalState = typeof sessionId === "string" ? state.goalActive.get(sessionId) : undefined;
			const lastStalledAt = (typeof sessionId === "string" ? state.stalledAt.get(sessionId) : 0) ?? 0;
			const stalledHit =
				toolCalls === 0 &&
				askedThisTurn !== true &&
				goalState === true &&
				Date.now() - lastStalledAt >= STALLED_DEDUPE_MS;
			note({ ev: "stalled/probe", sessionId, toolCalls, askedThisTurn, goalState, hit: stalledHit });
			if (stalledHit) {
				raiseStalled("turn-end", sessionId);
				return;
			}
			// 正常收尾：只报「本轮结束」（受 alertTurnEnd 控制；关掉时 completed 什么都不响）。
			// 「全部任务完成」只在 update_goal(complete) 响一次，**绝不由 turn/end 推断**：
			// 一轮对话跑完只代表这一轮结束，不代表任务完成。
			raise(
				ctx,
				state,
				prepare(),
				current,
				"turn-end",
				"本轮结束",
				"这一轮已经跑完，请回到 DSH 窗口查看结果或下达下一步。\n\n（dsh-alarm）",
				elapsedSeconds,
			);
		} catch (error) {
			ctx.logger?.warn?.(`dsh-alarm: turn/end 提醒失败：${error?.message ?? error}`);
		}
	});

	// 兜底：turn/end 偶尔缺席（极早中断）时，idle 状态转换仍是「这一轮结束」的信号。
	ctx.on("agent/status", (payload) => {
		try {
			if (payload?.status !== "idle") return;
			const agentId = agentIdOf(payload?.agent);
			const root = isRootAgent(ctx, payload?.agent);
			const current = settings();
			note({ ev: "idle", root, agentId });
			if (!root) return;
			// update_goal(complete) 已经发过「全部任务完成」→ 这次 idle 是同一件事，不再响。
			if (agentId !== null && state.completedTurnSent.delete(agentId)) {
				note({ ev: "skip", kind: "turn-end", why: "already-sent-this-turn" });
				return;
			}
			const body = "Agent 已经停下来等你，请回到 DSH 窗口查看。\n\n（dsh-alarm）";
			// idle 兜底只发「本轮结束」；alertTurnEnd 关掉时什么都不响
			//（idle 不是完成信号，绝不能报「全部任务完成」）。
			if (current.alertTurnEnd === true) {
				raise(ctx, state, prepare(), current, "turn-end", "本轮结束", body, null);
			}
		} catch (error) {
			ctx.logger?.warn?.(`dsh-alarm: idle 提醒失败：${error?.message ?? error}`);
		}
	});

	// 卸载时清掉聚合窗口的定时器：不清的话窗口到点还会用已经卸下的 ctx 再投递一次。
	// （applyAlarm 本身没有别的清理入口，这里借用宿主已有的 ctx.effect；宿主实现里没有
	//  effect 时就不挂，绝不自己造一个。）
	if (typeof ctx.effect === "function") {
		ctx.effect(
			() => () => {
				if (state.awaitingTestTimer !== null) {
					clearTimeout(state.awaitingTestTimer);
					state.awaitingTestTimer = null;
				}
			},
			"dsh-alarm: awaiting-test flush timer",
		);
	}

	// 预热脚本，避免第一次提醒还要付一次文件写入。
	prepare();
}
