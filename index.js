/** dsh-alarm：DSH 独立提醒报警插件（宿主侧 + 一张可视化设置页）。
 *
 * 投递方式：隐藏窗口的 powershell.exe 5.1 跑一个**纯 ASCII** 的 .ps1，播放铃声、
 * 可选 TTS 语音播报、可选弹窗 / toast。中文标题正文一律走 UTF-8 base64 参数。
 *
 * 配置：host/config.js 的 Config（扁平 volatile 字段）→ 设置页 / 侧的 HTTP 路由
 * 通过 ctx.settings.update("dsh-alarm", …) 落盘；lib/alarm.js 每次提醒现读 config。
 *
 * 注入：agents（root 会话判定）、settings（写设置）、webServer（注册 /api/dsh-alarm/*）。
 *
 * 装载自证：模块顶层写一行 `module-loaded`，apply 结束写 `apply-ok` / `apply-failed`
 * 到 `<DSH_HOME>/alarm/load.log`——用来区分「模块根本没被 import」与「apply 抛错被
 * 宿主静默吞掉」。写日志失败绝不影响加载；apply 失败先把日志落盘再 rethrow。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { applyAlarm } from "./lib/alarm.js";
import { applyRoutes } from "./host/routes.js";
import { Config } from "./host/config.js";

/** 插件名（loader 侧的名字，与 package.json 的 name 保持一致）。 */
const name = "dsh-alarm";

/** 依赖的宿主服务。 */
const inject = ["agents", "settings", "webServer"];

/** 推导 <DSH_HOME>：与 lib/alarm.js 同口径——显式环境变量优先（支持 ~ 展开），否则 per-user 默认。
 *  ponytail: 这里与 lib/alarm.js 的 dshHome() 重复一份（本轮只许改 index.js，复用它需先导出）。
 *  天花板：两处口径要手动同步；升级路径：把 dshHome 提到共享模块，alarm.js 改为引用。 */
function dshHome() {
	const env = process.env.DSH_HOME;
	if (typeof env === "string" && env.trim() !== "") {
		const raw = env.trim();
		const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
		return resolve(expanded);
	}
	return join(homedir(), ".dsh");
}

/** 装载诊断日志：<DSH_HOME>/alarm/load.log，一行一条 JSON。
 *  诊断不能影响主流程 → 目录创建 / 写盘的任何失败一律静默。
 *  ponytail: 不做轮转（一次装载只写 1~2 行，年增长可忽略）；要轮转就照 alarm.log 的 rename 做。 */
function noteLoad(entry) {
	try {
		const directory = join(dshHome(), "alarm");
		mkdirSync(directory, { recursive: true });
		const path = join(directory, "load.log");
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
	} catch {
		/* ignore：写日志失败不许把插件拖下水 */
	}
}

/** package.json 的 version（读不出来给 "unknown"，同样不许影响加载）。
 *  注意：本仓库 package.json 带 UTF-8 BOM，JSON.parse 会抛 → 先剥 BOM。 */
function pluginVersion() {
	try {
		const text = readFileSync(new URL("./package.json", import.meta.url), "utf8").replace(/^\uFEFF/, "");
		return JSON.parse(text).version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** 模块顶层自证：这一行出现 = 插件代码真的被 import 过了（loader 走到 apply 之前就先落盘）。 */
noteLoad({ ev: "module-loaded", pid: process.pid, version: pluginVersion(), node: process.version });

/** 插件入口。 */
function apply(ctx, config) {
	try {
		applyAlarm(ctx, config ?? {});
		applyRoutes(ctx, config ?? {});
		noteLoad({ ev: "apply-ok", pid: process.pid });
	} catch (error) {
		// 先落盘再抛：宿主若把异常吞成静默，load.log 里至少留下失败证据。
		noteLoad({
			ev: "apply-failed",
			pid: process.pid,
			message: String(error?.message ?? error),
			stack: String(error?.stack ?? "").slice(0, 1500),
		});
		throw error;
	}
}

export { apply, Config, inject, name };
