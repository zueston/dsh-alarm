/** dsh-alarm：DSH 独立提醒报警插件（宿主侧 + 一张可视化设置页）。
 *
 * 投递方式：隐藏窗口的 powershell.exe 5.1 跑一个**纯 ASCII** 的 .ps1，播放铃声、
 * 可选 TTS 语音播报、可选弹窗 / toast。中文标题正文一律走 UTF-8 base64 参数。
 *
 * 配置：host/config.js 的 Config（扁平 volatile 字段）→ 设置页 / 侧的 HTTP 路由
 * 通过 ctx.settings.update("dsh-alarm", …) 落盘；lib/alarm.js 每次提醒现读 config。
 *
 * 注入：agents（root 会话判定）、settings（写设置）、webServer（注册 /api/dsh-alarm/*）。
 */
import { applyAlarm } from "./lib/alarm.js";
import { applyRoutes } from "./host/routes.js";
import { Config } from "./host/config.js";

/** 插件名（loader 侧的名字，与 package.json 的 name 保持一致）。 */
const name = "dsh-alarm";

/** 依赖的宿主服务。 */
const inject = ["agents", "settings", "webServer"];

/** 插件入口。 */
function apply(ctx, config) {
	applyAlarm(ctx, config ?? {});
	applyRoutes(ctx, config ?? {});
}

export { apply, Config, inject, name };
