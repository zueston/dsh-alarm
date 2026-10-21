/** dsh-alarm 的宿主侧设置命名空间。
 *
 * 全部字段都是**扁平**的（单段名字）且带 `.volatile()`：volatile 字段不会因为
 * 修改而重载插件，而是以「活引用」的形式暴露在 apply() 拿到的 config 对象上，
 * 因此每次提醒现读 config 就能拿到最新值（dsh-switchman 的 host/config.js 用的
 * 是同一套约定）。
 *
 * 命名空间 = cordis.patch.yml 里的 loader 行 id（`- id: dsh-alarm`），见
 * host/routes.js 的 NS 常量说明。
 *
 * 通道模型：`alert<Kind>` 决定**要不要提醒**，`popup<Kind>` / `sound<Kind>` /
 * `voice<Kind>` 决定这条提醒**走哪几条通道**；三块通道各有总开关
 * （`popup` / `soundEnabled` / `voice`），与逐条件开关是「与」关系。
 */
import z from "@deepseek-ai/schemastery";

/** 设置命名空间（loader 行 id）。 */
export const DSH_ALARM_SETTINGS_NS = "dsh-alarm";

/** 弹窗可选风格（两种模式，二选一）：
 *  topmost=强弹窗（置顶窗口，显示几秒后自动关闭，不挡桌面操作）；
 *  toast=系统消息（只发 Windows 通知，完全不弹窗口）。
 *  旧值兼容（读入时静默改写，见 host/routes.js 的 normalize）：modal → topmost、none → topmost。 */
export const POPUP_STYLES = ["topmost", "toast"];

export const Config = z.object({
	/** 报警总开关（关掉后任何条件都不响）。 */
	enabled: z.boolean().default(true).volatile(),
	/** 有人要你裁决（ask_user_question）时提醒。 */
	alertAsk: z.boolean().default(true).volatile(),
	/** 需要你确认计划（exit_plan_mode）时提醒。 */
	alertPlan: z.boolean().default(true).volatile(),
	/** 全部任务完成（update_goal complete）时提醒。 */
	alertTaskComplete: z.boolean().default(true).volatile(),
	/** 每一轮正常结束都提醒（默认关：「任务完成」提醒已经覆盖它）。 */
	alertTurnEnd: z.boolean().default(false).volatile(),
	/** 本轮被手动打断（abort / interrupt / cancel / stop）时提醒（默认关）。 */
	alertTurnInterrupt: z.boolean().default(false).volatile(),
	/** 一轮异常报错（reason 不属于中断类）时提醒（默认关）。 */
	alertTurnError: z.boolean().default(false).volatile(),
	/** 设置页「测试提醒」按钮是否真的响铃（默认开）。 */
	alertTest: z.boolean().default(true).volatile(),
	/** 任务包被推进到「待人工测试」时提醒（状态.md 的「当前阶段」真的从别的值变成它时才响）。 */
	alertAwaitingTest: z.boolean().default(true).volatile(),
	/** agent 最后一条消息提到要重启 DSH 时提醒。 */
	alertRestart: z.boolean().default(true).volatile(),
	/** 只有本轮耗时 ≥ N 秒才提醒「结束」；0 = 不限制。 */
	minTurnSeconds: z.number().min(0).default(0).volatile(),
	/** 铃声文件名（C:\Windows\Media\*.wav 之一）。 */
	sound: z.string().default("Alarm03.wav").volatile(),
	/** 铃声重复次数（1–5）。 */
	soundRepeats: z.number().min(1).default(1).volatile(),
	/** 铃声的**总开关**：关闭后任何条件都不响铃。 */
	soundEnabled: z.boolean().default(true).volatile(),
	/** 语音播报（系统 TTS）的**总开关**：关闭后任何条件都不播报，只响铃/弹窗。 */
	voice: z.boolean().default(true).volatile(),
	/** 每条提醒自己的播报文本（空串 = 回落到下面的兜底模板 voiceText）。 */
	voiceTextAsk: z.string().default("需要你裁决").volatile(),
	voiceTextPlan: z.string().default("需要你确认计划").volatile(),
	voiceTextTaskComplete: z.string().default("全部任务完成").volatile(),
	voiceTextTurnEnd: z.string().default("本轮结束").volatile(),
	voiceTextInterrupt: z.string().default("本轮中断").volatile(),
	voiceTextError: z.string().default("本轮报错").volatile(),
	voiceTextAwaitingTest: z.string().default("需要你手工测试").volatile(),
	voiceTextRestart: z.string().default("需要重启 DSH").volatile(),
	voiceTextTest: z.string().default("这是语音测试示例").volatile(),
	/** 兜底播报模板：上面某条留空时用这条，支持 {title} / {body} 占位符。 */
	voiceText: z.string().default("{title}。{body}").volatile(),
	/** 语音名（空 = 系统默认语音）。 */
	voiceName: z.string().default("").volatile(),
	/** 语速（-5–5）。 */
	voiceRate: z.number().min(-5).default(0).volatile(),
	/** 音量（0–100）。 */
	voiceVolume: z.number().min(0).default(100).volatile(),
	/** 弹窗的**总开关**：关闭后任何条件都不弹窗。 */
	popup: z.boolean().default(true).volatile(),
	/** 弹窗风格：topmost=强弹窗 / toast=系统消息（schemastery 3.18 没有 z.enum，字符串枚举用 z.union）。 */
	popupStyle: z.union(POPUP_STYLES).default("topmost").volatile(),

	// ---- 每个条件的弹窗开关（与弹窗总开关是「与」关系）-------------------
	/** 裁决时弹窗。 */
	popupAsk: z.boolean().default(true).volatile(),
	/** 确认计划时弹窗。 */
	popupPlan: z.boolean().default(true).volatile(),
	/** 全部任务完成时弹窗。 */
	popupTaskComplete: z.boolean().default(true).volatile(),
	/** 需要重启 DSH 时弹窗（默认不弹：与「本轮结束」同属轻事件）。 */
	popupRestart: z.boolean().default(false).volatile(),
	/** 任务到「待人工测试」时弹窗。 */
	popupAwaitingTest: z.boolean().default(true).volatile(),
	/** 每一轮结束时弹窗（默认不弹，避免每轮都打断）。 */
	popupTurnEnd: z.boolean().default(false).volatile(),
	/** 本轮中断时弹窗（默认不弹）。 */
	popupTurnInterrupt: z.boolean().default(false).volatile(),
	/** 本轮报错时弹窗（默认不弹）。 */
	popupTurnError: z.boolean().default(false).volatile(),
	/** 手工测试提醒时弹窗。 */
	popupTest: z.boolean().default(true).volatile(),

	// ---- 每个条件的铃声开关（与铃声总开关是「与」关系）---------------
	soundAsk: z.boolean().default(true).volatile(),
	soundPlan: z.boolean().default(true).volatile(),
	soundTaskComplete: z.boolean().default(true).volatile(),
	soundRestart: z.boolean().default(true).volatile(),
	soundAwaitingTest: z.boolean().default(true).volatile(),
	soundTurnEnd: z.boolean().default(true).volatile(),
	soundTurnInterrupt: z.boolean().default(true).volatile(),
	soundTurnError: z.boolean().default(true).volatile(),
	soundTest: z.boolean().default(true).volatile(),

	// ---- 每个条件的语音播报开关（与语音播报总开关是「与」关系）-----------
	voiceAsk: z.boolean().default(true).volatile(),
	voicePlan: z.boolean().default(true).volatile(),
	voiceTaskComplete: z.boolean().default(true).volatile(),
	voiceRestart: z.boolean().default(true).volatile(),
	voiceAwaitingTest: z.boolean().default(true).volatile(),
	voiceTurnEnd: z.boolean().default(true).volatile(),
	voiceTurnInterrupt: z.boolean().default(true).volatile(),
	voiceTurnError: z.boolean().default(true).volatile(),
	voiceTest: z.boolean().default(true).volatile(),

	/** 同一类提醒的最小间隔（秒）。 */
	throttleSeconds: z.number().min(0).default(4).volatile(),
	/** ask 之后紧接着的 idle 视为同一件事的闩锁时长（秒）。 */
	askLatchSeconds: z.number().min(0).default(15).volatile(),
});

export default Config;
