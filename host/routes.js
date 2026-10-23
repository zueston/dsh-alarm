/** dsh-alarm 的宿主侧 HTTP 路由（给可视化设置页用）。
 *
 * 浏览器半体跑在受限的动态模块运行时里：没有 configForms / remote 服务、也没有
 * 直接网络，唯一合法的桥是**同源 fetch** 打宿主注册在 ctx.webServer 上的路由
 * （要点：字段类型与默认值集中在一张 FIELDS 表，读写都走它，两端只交换同源 HTTP 的 JSON）。
 *
 *   GET  /api/dsh-alarm/config  — { values, expected, defaults, options: { wavs, voices } }
 *                                 （defaults = 所有字段的 FIELDS 默认值，供「恢复默认」整体替换）
 *   POST /api/dsh-alarm/config  — { expected, values } 乐观并发写入 ctx.settings.update
 *                                 校验顺序：体/值非法 → 400 `invalid values payload`；
 *                                 **三个 showIn\* 全 false → 400 `code:"last-slot"`**（见 SLOT_KEYS）；
 *                                 快照过期 → 409 + 新快照
 *   POST /api/dsh-alarm/test    — 立刻触发一次真机提醒（试听/测试按钮）；body 可选
 *                                 { kind, values }：带 values 时按**页面当前勾选**
 *                                 （含未保存改动）响，缺省/非法则回退已保存配置
 *   GET  /api/dsh-alarm/agent-rules — { ok, text, source, missing }：`docs/agent-output-prompt.md`
 *                                 里第一个 ```text 围栏块（可一键复制粘给 agent 的规则块）。
 *                                 **只读**；文件读不到也回 200 + missing:true。
 *   POST /api/dsh-alarm/sound   — { fileName, dataBase64 }：上传自定义铃声。**只读请求 + 写一个文件**：
 *                                 校验 .wav 扩展名 / 解码后 ≤ 2 MB / 前 4 字节 RIFF，文件名清洗后
 *                                 落到 `<DSH_HOME>/alarm/sounds/dsh-alarm-<清洗名>`，回
 *                                 { ok, path, bytes }（path 是绝对路径，设置页存进 `sound` 字段）。
 *                                 校验失败一律 400 `{ error }`，写盘失败 500 `{ error }`。
 *   GET  /api/dsh-alarm/health  — 存活探针
 *
 * 信任边界：loopback（Host 头 + Origin/Sec-Fetch-Site 校验）或已配对的远程 UI
 * 设备；设置写会落盘，未配对的局域网客户端一律拒绝。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DSH_ALARM_SETTINGS_NS } from "./config.js";
import {
	TEST_KINDS,
	alarmLogPath,
	alarmSoundsDir,
	materializeScript,
	settingsOf,
	testAlert,
} from "../lib/alarm.js";
import { listInstalledVoices } from "../lib/voices.js";

/** 路由路径（client.js 里镜像了同样的字面量）。 */
const ROUTES = {
	health: "/api/dsh-alarm/health",
	config: "/api/dsh-alarm/config",
	test: "/api/dsh-alarm/test",
	agentRules: "/api/dsh-alarm/agent-rules",
	sound: "/api/dsh-alarm/sound",
};

/** 「报警规则块」的唯一来源：插件自带的说明文档。
 *
 *  路径**按本模块自身位置解析**（`import.meta.url` 是 host/routes.js，向上一级即插件根），
 *  绝不写死绝对路径：插件被装到哪个目录、是否被复制到临时目录都无所谓。
 *  内容侧只读一次、不外传：本路由没有任何写操作，也不接受参数。 */
const RULES_FILE = new URL("../docs/agent-output-prompt.md", import.meta.url);
const RULES_SOURCE = "docs/agent-output-prompt.md";

/** 设置命名空间：cordis.patch.yml 里的 loader 行 id（`- id: dsh-alarm`），
 *  不是插件的 name —— dsh-settings 的 write() 按 entry.options.id 查找条目。 */
const NS = DSH_ALARM_SETTINGS_NS;

/** 字段规格（与 host/config.js 一一对应）。 */
const FIELDS = {
	enabled: { kind: "bool", def: true },
	// 这张设置卡片注册/显示在哪里（三个空间各一个扁平 bool）：
	// 主窗口（侧栏铃铛 + 设置浮层）默认开；插件页 / 设置页默认关（首次使用只有主窗口）。
	showInMain: { kind: "bool", def: true },
	showInPlugins: { kind: "bool", def: false },
	showInSettings: { kind: "bool", def: false },
	alertAsk: { kind: "bool", def: true },
	alertPlan: { kind: "bool", def: true },
	alertTaskComplete: { kind: "bool", def: true },
	alertTurnEnd: { kind: "bool", def: false },
	alertTurnInterrupt: { kind: "bool", def: false },
	alertTurnError: { kind: "bool", def: true },
	alertStalled: { kind: "bool", def: true },
	alertTest: { kind: "bool", def: true },
	alertAwaitingTest: { kind: "bool", def: true },
	alertRestart: { kind: "bool", def: true },
	minTurnSeconds: { kind: "number", def: 0, min: 0, max: 86_400 },
	// 铃声：系统铃声文件名（%SystemRoot%\Media 下）**或自定义 wav 的绝对路径**
	// （上传路由 POST /api/dsh-alarm/sound 返回的 path 就是这种）。不限制取值：
	// 文件是否存在由脚本侧 Test-Path 兜底，这里拦住会让设置页存不回去。
	sound: { kind: "string", def: "Alarm03.wav" },
	soundRepeats: { kind: "number", def: 1, min: 1, max: 5 },
	soundEnabled: { kind: "bool", def: true },
	// 语音播报总开关：关闭后任何条件都不播报，只响铃/弹窗。
	voice: { kind: "bool", def: true },
	// 每条提醒自己的播报文本（空串 = 回落到 voiceText 兜底模板）。
	voiceTextAsk: { kind: "string", def: "需要你裁决" },
	voiceTextPlan: { kind: "string", def: "需要你确认计划" },
	voiceTextTaskComplete: { kind: "string", def: "全部任务完成" },
	voiceTextTurnEnd: { kind: "string", def: "本轮结束" },
	voiceTextInterrupt: { kind: "string", def: "本轮中断" },
	voiceTextError: { kind: "string", def: "本轮报错" },
	voiceTextStalled: { kind: "string", def: "我停下来了，没有后续动作" },
	voiceTextAwaitingTest: { kind: "string", def: "需要你手工测试" },
	voiceTextRestart: { kind: "string", def: "需要重启 DSH" },
	voiceTextTest: { kind: "string", def: "这是语音测试示例" },
	voiceText: { kind: "string", def: "{title}。{body}" },
	voiceName: { kind: "string", def: "" },
	voiceRate: { kind: "number", def: 0, min: -5, max: 5 },
	voiceVolume: { kind: "number", def: 100, min: 0, max: 100 },
	popup: { kind: "bool", def: true },
	// 弹窗两种模式（topmost=强弹窗 / toast=系统消息）；aliases 是旧值兼容：
	// 读入时静默改写，不报错（modal / none 都已并入 topmost）。
	popupStyle: {
		kind: "enum",
		def: "topmost",
		values: ["topmost", "toast"],
		aliases: { modal: "topmost", none: "topmost" },
	},
	// 每个条件的三条通道开关（与三块通道总开关是「与」关系）。
	popupAsk: { kind: "bool", def: true },
	popupPlan: { kind: "bool", def: true },
	popupTaskComplete: { kind: "bool", def: true },
	popupRestart: { kind: "bool", def: false },
	popupAwaitingTest: { kind: "bool", def: true },
	popupTurnEnd: { kind: "bool", def: false },
	popupTurnInterrupt: { kind: "bool", def: false },
	popupTurnError: { kind: "bool", def: false },
	popupStalled: { kind: "bool", def: true },
	popupTest: { kind: "bool", def: true },
	soundAsk: { kind: "bool", def: true },
	soundPlan: { kind: "bool", def: true },
	soundTaskComplete: { kind: "bool", def: true },
	soundRestart: { kind: "bool", def: true },
	soundAwaitingTest: { kind: "bool", def: true },
	soundTurnEnd: { kind: "bool", def: true },
	soundTurnInterrupt: { kind: "bool", def: true },
	soundTurnError: { kind: "bool", def: true },
	soundStalled: { kind: "bool", def: true },
	soundTest: { kind: "bool", def: true },
	voiceAsk: { kind: "bool", def: true },
	voicePlan: { kind: "bool", def: true },
	voiceTaskComplete: { kind: "bool", def: true },
	voiceRestart: { kind: "bool", def: true },
	voiceAwaitingTest: { kind: "bool", def: true },
	voiceTurnEnd: { kind: "bool", def: true },
	voiceTurnInterrupt: { kind: "bool", def: true },
	voiceTurnError: { kind: "bool", def: true },
	voiceStalled: { kind: "bool", def: true },
	voiceTest: { kind: "bool", def: true },
	// 「待人工测试」提醒的批次/聚合规则（合并测试批次：一批任务只响一次、响时带待测清单）。
	// 四个字段都是扁平字段（不做嵌套对象，否则设置页读不到）。
	awaitingTestScope: { kind: "enum", def: "all", values: ["all", "anchor"] },
	awaitingTestAnchor: { kind: "string", def: "批次" },
	awaitingTestQuietSeconds: { kind: "number", def: 0, min: 0, max: 86_400 },
	awaitingTestSummary: { kind: "bool", def: true },
	// 严格输出协议（**两态**）：tag-first=默认模式（标签优先 + 旧判定兜底）/ tag-only=严格模式（只认标签）。
	// aliases 兼容历史值——布尔 true/false（1.3.x）与已删除的第三态 heuristic-only：
	// 读入时静默改写为**默认模式**（标签优先 + 旧判定兜底），不报错：磁盘上留着旧值的配置
	// 既能正常装载，也能被设置页原样存回去（存回去时已是两态字符串）。
	protocolMode: {
		kind: "enum",
		def: "tag-first",
		values: ["tag-first", "tag-only"],
		aliases: { true: "tag-first", false: "tag-first", "heuristic-only": "tag-first" },
	},
	throttleSeconds: { kind: "number", def: 4, min: 0, max: 3600 },
	askLatchSeconds: { kind: "number", def: 15, min: 0, max: 86_400 },
};

/** 「卡片注册范围」的三个开关（标题行那三个勾选框）。**不许同时为 false**：
 *  全关等于这张设置卡片再无入口（用户把自己锁在外面），由 `POST /config` 兜底 400 拒绝。
 *  与 client.js 的 `SLOT_FIELDS`、host/config.js 的 schema、lib/alarm.js 的 DEFAULTS 同名。 */
const SLOT_KEYS = ["showInMain", "showInPlugins", "showInSettings"];

/** JSON 响应助手。 */
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(body);
}

/** 自定义铃声上传的上限：**解码后 ≤ 2 MB**（WAV 头 + 采样数据；每次提醒都要现播，
 *  再大的文件不适合走这个通道）。 */
const SOUND_MAX_BYTES = 2 * 1024 * 1024;
/** 上传请求体上限：base64 约为原文的 4/3（2 MB → 约 2.7 MB），再给 JSON 外壳与文件名留余量。
 *  比 2 MB 大一截是**故意的**：超限要由解码后的字节数来判，才能回「具体原因」的 400，
 *  而不是在解析阶段就被通用体上限挡掉。 */
const SOUND_BODY_MAX_BYTES = 3 * 1024 * 1024;
/** 落盘文件名前缀：避免覆盖用户自己放进 sounds 目录的同名文件。 */
const SOUND_PREFIX = "dsh-alarm-";

/** 清洗上传文件名：只保留 `[A-Za-z0-9._-]`，其余（含 `/` `\` 空格 中文 控制符）一律替换成 `_`，
 *  再前置 `dsh-alarm-`。清洗后不含任何路径分隔符 → 结果永远是 sounds 目录下的**单个文件名**，
 *  没有目录穿越面（`..\evil name.wav` → `dsh-alarm-.._evil_name.wav`，仍在目录内）。 */
function soundFileName(fileName) {
	return `${SOUND_PREFIX}${String(fileName).replace(/[^A-Za-z0-9._-]/gu, "_")}`;
}

/** 读取并解析一个 JSON 请求体（缺省 1 MiB 上限；上传铃声传更大的上限）。 */
function readJsonBody(req, maxBytes = 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(new Error(`invalid JSON body: ${error?.message ?? error}`));
			}
		});
		req.on("error", reject);
	});
}

/** Host 头里的主机名是否是本机 loopback。 */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	if (!hostname || hostname.startsWith("[")) return false;
	const parts = hostname.split(".");
	return parts.length === 4 && parts.every((p) => /^\d+$/u.test(p)) && parts[0] === "127";
}

/** 请求是否来自本机自己的页面。 */
function isLoopbackRequest(request) {
	const host = request.headers?.host;
	if (typeof host !== "string" || host === "") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/** loopback，或（remote-web-ui 存在时）已配对设备。 */
function isAllowed(ctx, request) {
	if (isLoopbackRequest(request)) return true;
	const pairing = typeof ctx.get === "function" ? ctx.get("remoteWebUiPairing", false) : undefined;
	return (
		pairing !== undefined &&
		pairing !== null &&
		typeof pairing.isPairedDevice === "function" &&
		pairing.isPairedDevice(request) === true
	);
}

/** 读一个 volatile 字段的当前值；getter 抛错时返回 undefined。 */
function rawOf(field) {
	if (field !== null && typeof field === "object" && typeof field.get === "function") {
		try {
			return field.get();
		} catch {
			return undefined;
		}
	}
	return field;
}

/** 把一个原始值规整成合法值；非法返回 undefined。 */
function normalize(name, raw) {
	const spec = FIELDS[name];
	if (spec === undefined) return undefined;
	if (spec.kind === "bool") return typeof raw === "boolean" ? raw : undefined;
	if (spec.kind === "number") {
		const value = Number(raw);
		if (!Number.isFinite(value) || value < spec.min || value > spec.max) return undefined;
		return value;
	}
	if (spec.kind === "enum") {
		// 旧值兼容：先按 aliases 静默改写（modal / none → topmost），再校验。
		const value = spec.aliases?.[raw] ?? raw;
		return spec.values.includes(value) ? value : undefined;
	}
	return typeof raw === "string" ? raw : undefined;
}

/** 当前设置快照（plain JSON，非法值回落默认值）。 */
export function snapshotOf(config) {
	const values = {};
	for (const name of Object.keys(FIELDS)) {
		const normalized = normalize(name, rawOf(config?.[name]));
		values[name] = normalized === undefined ? FIELDS[name].def : normalized;
	}
	return values;
}

/** 校验客户端提交的 values；任何一个字段非法都返回 null。 */
function coerceValues(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
	const values = {};
	for (const name of Object.keys(FIELDS)) {
		const normalized = normalize(name, input[name]);
		if (normalized === undefined) return null;
		values[name] = normalized;
	}
	return values;
}

/** 两个 plain-JSON 值是否相等。 */
function sameValues(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** 系统铃声目录。 */
function mediaDir() {
	return join(process.env.SystemRoot ?? "C:\\Windows", "Media");
}

/** 列出可用铃声文件名（排序，失败给空数组）。 */
function listWavs() {
	try {
		return readdirSync(mediaDir())
			.filter((name) => name.toLowerCase().endsWith(".wav"))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/** 已安装 TTS 语音名：枚举实现与 5 分钟缓存都在 lib/voices.js，
 *  报警投递的「网络音色失败 → 回退离线音色」复用同一份，避免两处口径漂移。 */
function listVoices(logger) {
	return listInstalledVoices(logger);
}

/** 从 markdown 里取出**第一个** ```text 围栏块的正文。
 *
 *  - 只取第一个 ```text 到它的**收尾围栏**之间的内容；块内换行原样保留（前端要**逐字**复制）。
 *  - 只去掉块首、块尾的空行（对齐「去掉首尾空行」，不做 trim 其余空白）。
 *  - **收尾围栏按 CommonMark 判：必须独占一行**（行首 ``` 起头）。不能拿「正文里出现的第一个
 *    三个反引号」当收尾——docs/agent-output-prompt.md 的 R1 那句里就有一个行内的 ```...```
 *    （「围栏代码块内的文字一律不算」），按字符位置截会只截到那一行，规则块少掉九成内容。
 *  - 找不到围栏/围栏没闭合 → 回退整份文件，并把 source 标成「整文件」，让前端能看出降级。
 */
function extractRulesBlock(raw) {
	const full = String(raw ?? "");
	const lines = full.split("\n");
	const open = lines.findIndex((line) => line.trimStart().startsWith("```text"));
	if (open < 0) return { text: full.trim(), source: `${RULES_SOURCE}（整文件）` };
	let close = -1;
	for (let i = open + 1; i < lines.length; i += 1) {
		if (lines[i].trimStart().startsWith("```")) {
			close = i;
			break;
		}
	}
	if (close < 0) return { text: full.trim(), source: `${RULES_SOURCE}（整文件）` };
	// 按行切片再拼回去：**块内每一行的原样内容（含行尾 \r）都保留**，只砍首尾空行。
	const block = lines.slice(open + 1, close);
	while (block.length > 0 && block[0].trim() === "") block.shift();
	while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
	return { text: block.join("\n"), source: RULES_SOURCE };
}

/** GET /agent-rules 的响应体。
 *
 *  读文件失败（文件缺失、权限、编码）**仍然 200 + missing:true**：这是「插件不完整」的
 *  提示态，不是请求错误——前端据此显示「规则文件缺失」而不是一条红色报错。
 *  `ok` 恒为 true：前端只要拿到 JSON 就说明路由通了。 */
function rulesPayload() {
	try {
		const { text, source } = extractRulesBlock(readFileSync(RULES_FILE, "utf8"));
		return { ok: true, text, source, missing: false };
	} catch (error) {
		return { ok: true, text: "", source: RULES_SOURCE, missing: true, error: String(error?.message ?? error) };
	}
}

/** GET /config 的响应体。
 *
 *  `defaults` = `snapshotOf({})`：把**每一个字段**都按 FIELDS 的 def 取一遍（键与 `values`
 *  完全一致，同一个循环生成），供设置页的「恢复默认」按钮整体替换页面 values。
 *  **必须与当前配置无关**：传 `{}` 才能拿到纯默认值，传 config 会变成又一份当前快照。 */
function configPayload(ctx, config) {
	const values = snapshotOf(config);
	const defaults = snapshotOf({});
	const options = { wavs: listWavs(), voices: listVoices(ctx?.logger) };
	return { values, expected: values, defaults, options };
}

/** 构造 /api/dsh-alarm 路由族（精确路径）。 */
export function makeRoutes(ctx, config) {
	/** 围栏：信任边界 + 方法。 */
	const guard = (req, res, method) => {
		if (!isAllowed(ctx, req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};

	return [
		{
			kind: "exact",
			path: ROUTES.health,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, { ok: true, ns: NS, logPath: alarmLogPath() });
			},
		},
		{
			kind: "exact",
			path: ROUTES.config,
			handler: async (req, res) => {
				if (!isAllowed(ctx, req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method === "GET") {
					writeJson(res, 200, configPayload(ctx, config));
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					writeJson(res, 400, { error: error?.message ?? String(error) });
					return;
				}
				const values = coerceValues(body?.values);
				if (values === null) {
					writeJson(res, 400, { error: "invalid values payload" });
					return;
				}
				// 三个注册范围（主窗口 / 插件页 / 设置页）**不许同时关掉**：全关 = 这张设置卡片
				// 再无任何入口，只能去手改配置才能救回来。校验放在服务端（唯一兜底）：
				// 前端那层「最后一个勾选置灰」已按用户要求去掉，改由这里拒绝 + 页面回滚。
				if (SLOT_KEYS.every((key) => values[key] !== true)) {
					writeJson(res, 400, {
						error: "至少要保留一个入口（主窗口 / 插件页 / 设置页），否则你将再也打不开这个设置页",
						code: "last-slot",
					});
					return;
				}
				// 乐观并发：客户端提交它加载时的快照，若已变化则 409 + 新快照。
				const current = snapshotOf(config);
				if (body.expected !== undefined) {
					const expected = coerceValues(body.expected);
					if (expected === null || !sameValues(expected, current)) {
						writeJson(res, 409, { error: "conflict: settings changed since load", values: current });
						return;
					}
				}
				try {
					await ctx.settings.update(NS, values);
				} catch (error) {
					ctx.logger?.warn?.(`dsh-alarm: settings write failed: ${error?.message ?? error}`);
					writeJson(res, 500, { error: error?.message ?? String(error) });
					return;
				}
				writeJson(res, 200, configPayload(ctx, config));
			},
		},
		{
			kind: "exact",
			path: ROUTES.test,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					// 条件表逐行试听：body 可选 { kind }（TEST_KINDS 白名单，非法即回落 "test"）。
					// 空体/非法 JSON 一律按 {} 处理，不让试听按钮 500。
					let body = {};
					try {
						const parsed = await readJsonBody(req);
						if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
							body = parsed;
						}
					} catch (error) {
						// 超限体已被 readJsonBody 里 req.destroy() 掉，不能再往下走。
						if (String(error?.message ?? error).includes("body too large")) {
							writeJson(res, 413, { error: "body too large" });
							return;
						}
						body = {};
					}
					const requested = body.kind;
					const kind = typeof requested === "string" && TEST_KINDS.includes(requested) ? requested : "test";
					// 试听口径：body 里带了 values（设置页当前勾选，可能含**还没保存**的改动）
					// 就按它响；走与 POST /config 完全相同的规范化/校验路径（coerceValues，
					// 含 popupStyle 的 modal|none → topmost 别名），得到一份纯对象配置。
					// 没带、或规范化失败 → 回退当前已保存配置（保持旧行为，不 500）。
					// testAlert 内部走 settingsOf(config)，对纯对象同样有效。
					const pending = coerceValues(body.values);
					const effective = pending === null ? config : pending;
					// 记录日志当前长度，稍后用它判断 .ps1 是否真的跑起来了：
					// 宿主若在受限 Job 里 spawn（例如带 detached），进程会静默不执行。
					const { readFileSync, statSync } = await import("node:fs");
					const logPath = alarmLogPath();
					let offset = 0;
					try {
						offset = statSync(logPath).size;
					} catch {
						offset = 0;
					}
					const delivered = testAlert(ctx, effective, kind);
					let scriptStarted = false;
					if (delivered) {
						await new Promise((resolve) => setTimeout(resolve, 1800));
						try {
							const appended = readFileSync(logPath).subarray(offset).toString("utf8");
							scriptStarted = appended.includes('"stage":"start"');
						} catch {
							scriptStarted = false;
						}
					}
					// settings 用**实际生效**的那份（带了 values 就是页面传入的值），
					// 让设置页能立刻看出「这次试听用的是哪套勾选」。
					writeJson(res, 200, { ok: true, kind, delivered, scriptStarted, settings: settingsOf(effective) });
				} catch (error) {
					ctx.logger?.warn?.(`dsh-alarm: 测试提醒失败：${error?.message ?? error}`);
					writeJson(res, 500, { error: error?.message ?? String(error) });
				}
			},
		},
		{
			// 只读：把插件自带的「报警规则块」交给前端弹窗（一键复制 → 粘给 agent）。
			// 与其它路由同一道信任边界（loopback / 已配对设备）+ 只允许 GET，无任何写操作。
			kind: "exact",
			path: ROUTES.agentRules,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, rulesPayload());
			},
		},
		{
			// 上传自定义铃声：**唯一一个会写文件的请求**——只写 `<DSH_HOME>/alarm/sounds`
			// 下一个经清洗的 wav，成功回绝对路径（设置页把它存进 `sound` 字段）。
			// 与其它路由同一道信任边界（loopback / 已配对设备）+ 只接受 POST。
			kind: "exact",
			path: ROUTES.sound,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				let body;
				try {
					body = await readJsonBody(req, SOUND_BODY_MAX_BYTES);
				} catch (error) {
					// 上传接口的失败面只有两种：400（请求/内容不合法，带具体原因）与 500（写盘失败）。
					// 所以体超限也归到 400，不沿用 /test 的 413。
					const message = String(error?.message ?? error);
					writeJson(res, 400, {
						error: message.includes("body too large")
							? `request body too large (limit ${SOUND_BODY_MAX_BYTES} bytes)`
							: message,
					});
					return;
				}
				// 1) 扩展名：必须以 .wav 结尾（不区分大小写）——先看名字，避免为明显非法的请求解码。
				const fileName = typeof body?.fileName === "string" ? body.fileName : "";
				if (!fileName.toLowerCase().endsWith(".wav")) {
					writeJson(res, 400, { error: "fileName must end with .wav" });
					return;
				}
				// 2) 内容：base64 → 字节。大小与魔数都要过，否则声音会静默不响。
				const dataBase64 = typeof body?.dataBase64 === "string" ? body.dataBase64 : "";
				if (dataBase64 === "") {
					writeJson(res, 400, { error: "dataBase64 is required (base64-encoded wav bytes)" });
					return;
				}
				const bytes = Buffer.from(dataBase64, "base64");
				if (bytes.length === 0) {
					writeJson(res, 400, { error: "dataBase64 decoded to 0 bytes" });
					return;
				}
				if (bytes.length > SOUND_MAX_BYTES) {
					writeJson(res, 400, {
						error: `wav too large: ${bytes.length} bytes (limit ${SOUND_MAX_BYTES} bytes)`,
					});
					return;
				}
				if (bytes.length < 4 || bytes.subarray(0, 4).toString("latin1") !== "RIFF") {
					// ponytail: 只认 RIFF 魔数，不解析 WAVE/fmt 块（够挡住「随便一个文件改名成 .wav」；
					// 播放侧 SoundPlayer 自己会失败并回落到 beep）。天花板：非 PCM/损坏的 WAV 仍能上传成功。
					// 升级路径：若真出现「传上去但播不出」，再补 bytes[8..12] === "WAVE" 与 fmt 块校验。
					writeJson(res, 400, { error: "not a wav file: missing RIFF header" });
					return;
				}
				// 3) 落盘：名字清洗成单个路径段，目录按需创建。
				const directory = alarmSoundsDir();
				const path = join(directory, soundFileName(fileName));
				try {
					mkdirSync(directory, { recursive: true });
					writeFileSync(path, bytes);
				} catch (error) {
					ctx.logger?.warn?.(`dsh-alarm: 自定义铃声写入失败：${error?.message ?? error}`);
					writeJson(res, 500, { error: error?.message ?? String(error) });
					return;
				}
				writeJson(res, 200, { ok: true, path, bytes: bytes.length });
			},
		},
	];
}

/** 挂载路由族（通过 ctx.effect 可随插件卸载）。 */
export function applyRoutes(ctx, config) {
	const routes = makeRoutes(ctx, config);
	ctx.effect(() => {
		const disposers = routes.map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-alarm: client routes");
	// 预热：把 .ps1 与设置快照尽早准备好。
	materializeScript(ctx?.logger);
}
