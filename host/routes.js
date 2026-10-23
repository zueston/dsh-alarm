/** dsh-alarm 的宿主侧 HTTP 路由（给可视化设置页用）。
 *
 * 浏览器半体跑在受限的动态模块运行时里：没有 configForms / remote 服务、也没有
 * 直接网络，唯一合法的桥是**同源 fetch** 打宿主注册在 ctx.webServer 上的路由
 * （与 dsh-switchman / skill-explorer 用的同一套模式）。
 *
 *   GET  /api/dsh-alarm/config  — { values, expected, defaults, options: { wavs, voices } }
 *                                 （defaults = 所有字段的 FIELDS 默认值，供「恢复默认」整体替换）
 *   POST /api/dsh-alarm/config  — { expected, values } 乐观并发写入 ctx.settings.update
 *   POST /api/dsh-alarm/test    — 立刻触发一次真机提醒（试听/测试按钮）；body 可选
 *                                 { kind, values }：带 values 时按**页面当前勾选**
 *                                 （含未保存改动）响，缺省/非法则回退已保存配置
 *   GET  /api/dsh-alarm/agent-rules — { ok, text, source, missing }：`docs/agent-output-prompt.md`
 *                                 里第一个 ```text 围栏块（可一键复制粘给 agent 的规则块）。
 *                                 **只读**；文件读不到也回 200 + missing:true。
 *   GET  /api/dsh-alarm/health  — 存活探针
 *
 * 信任边界：loopback（Host 头 + Origin/Sec-Fetch-Site 校验）或已配对的远程 UI
 * 设备；设置写会落盘，未配对的局域网客户端一律拒绝。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DSH_ALARM_SETTINGS_NS } from "./config.js";
import { TEST_KINDS, alarmLogPath, materializeScript, settingsOf, testAlert } from "../lib/alarm.js";
import { listInstalledVoices } from "../lib/voices.js";

/** 路由路径（client.js 里镜像了同样的字面量）。 */
const ROUTES = {
	health: "/api/dsh-alarm/health",
	config: "/api/dsh-alarm/config",
	test: "/api/dsh-alarm/test",
	agentRules: "/api/dsh-alarm/agent-rules",
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
	popupStalled: { kind: "bool", def: false },
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
	// 严格输出协议（三态）：tag-first=标签优先 + 旧判定兜底（默认）/ tag-only=只认标签 /
	// heuristic-only=只用旧判定。aliases 兼容**旧布尔配置**（老配置里存的是 true/false）：
	// 读入时静默改写（true → tag-first、false → heuristic-only），不报错。
	protocolMode: {
		kind: "enum",
		def: "tag-first",
		values: ["tag-first", "tag-only", "heuristic-only"],
		aliases: { true: "tag-first", false: "heuristic-only" },
	},
	throttleSeconds: { kind: "number", def: 4, min: 0, max: 3600 },
	askLatchSeconds: { kind: "number", def: 15, min: 0, max: 86_400 },
};

/** JSON 响应助手。 */
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(body);
}

/** 读取并解析一个 JSON 请求体（1 MiB 上限）。 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 1024 * 1024) {
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
