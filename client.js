/** dsh-alarm 的浏览器半体（客户端设置界面 + 侧边栏入口）。
 *
 * 自包含：客户端模块系统每个包只加载一个 bundle，所以这里不 import 任何兄弟
 * 文件，只 `require('react')`。
 * 入口写法：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return { inject, apply } } })
 *
 * 注册的槽位（恰好五个，**不注册 main**）：
 *   1. sidebar.panellist       —— 主窗口侧边栏「报警提醒」铃铛入口（order 33）。
 *      点它只开浮层，不切主区域。
 *   2. shell.overlay           —— 设置弹窗本体（宿主官方浮层槽位，order 120）。
 *      **不再用 portal 挂 body**：那条路一弹窗就白屏，改成槽位后稳定。
 *   3. settings.section        —— 设置页里的一张「报警提醒（dsh-alarm）」卡片
 *   4. plugins.bundle.config   —— 「插件」页里同一个组件的第二入口
 *   5. shell.overlay（第二个） —— 「编辑报警规则」弹窗（order 121，与设置弹窗并列）。
 *      它是**独立的一条注册**，不并进设置弹窗：规则块只是「看 + 复制」，不需要配置读写。
 *  **绝不注册 `main` 槽位**：注册了就等于把「报警提醒」变成宿主可选的中间面板，
 *  一选中主区域就渲染成空——用户实测的「点铃铛后会话界面白屏」就是这么来的。
 *  宿主浮层类插件同理，只应注册 sidebar.panellist + shell.overlay 这两个槽位。
 *   所有槽位组件都过 `guarded()` 错误边界：任何一块渲染崩了只让这块变空，
 *   绝不让整页白屏（白屏就是 React 卸载整棵宿主树的结果）。
 *
 * 数据全部走宿主路由的**同源 fetch**（受限运行时没有别的网络能力）：
 *   GET  api/dsh-alarm/config  { values, expected, options: { wavs, voices } }
 *   POST api/dsh-alarm/config  { expected, values }
 *   POST api/dsh-alarm/test    { kind, values }  （按页面当前勾选试听：连未保存的改动一起发）
 *   GET  api/dsh-alarm/agent-rules { ok, text, source, missing }  （「编辑报警规则」弹窗的只读正文）
 *
 * 勾选即自动保存（400ms 防抖）：改完就落盘，不再有「勾了但没点保存」的状态；
 * 底部「保存」按钮保留为手动重试入口，「重新载入」丢弃本地改动回到磁盘配置。
 *
 * **配置走模块级缓存**（`configCache` / `refreshConfig()` / `useConfigCache()`）：
 * `apply()` 里预加载一次，卡片挂载时先吃缓存、缓存没就绪才发请求；保存成功后回写缓存。
 * 目的只有一个：点开弹窗立刻看到完整表单（原先每次挂载都 GET 一次，必然闪「正在载入」）。
 * 条件表/字段行都加了 `React.memo` + 比较器：勾一个复选框只重渲染那一行，
 * 不再整棵树重建（原先勾选明显卡顿）。两处都别改回「每次全量」。
 */

window.__ModuleLoader__.load({
	id: 'dsh-alarm',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** 渲染护栏：把组件包进错误边界，崩了只让这一块变空，绝不白屏整页。
		 *
		 *  形态：
		 *  class 错误边界 + `getDerivedStateFromError` + `componentDidCatch` 里打一条
		 *  console.error，`render()` 在失败态返回 null。
		 *
		 *  为什么必须有：任一组件在渲染期抛错，React 会把整棵宿主树卸载掉——用户看到的
		 *  就是「弹窗一出现 DSH 白屏」。所有槽位组件都必须过这层，坏一块只空一块。 */
		function guarded(name, Component) {
			class AlarmBoundary extends React.Component {
				constructor(props) {
					super(props);
					this.state = { failed: false };
				}
				static getDerivedStateFromError() {
					return { failed: true };
				}
				componentDidCatch(error, info) {
					console.error(
						'[dsh-alarm] render-error',
						name,
						String(error?.message ?? error),
						String(error?.stack ?? '').slice(0, 1500),
						String(info?.componentStack ?? '').slice(0, 800),
					);
				}
				render() {
					return this.state.failed ? null : this.props.children;
				}
			}
			return function Guarded(props) {
				return h(AlarmBoundary, { name }, h(Component, props));
			};
		}

		/** 设置命名空间（与宿主 host/config.js 一致）。 */
		const NS = 'dsh-alarm';

		/** 宿主路由前缀（文档相对：DSH 用 <base href="./"> 提供 GUI）。 */
		const API_BASE = 'api/dsh-alarm/';

		/** 勾选即自动保存的防抖窗口（ms）：连续勾选只发一次 POST。 */
		const AUTO_SAVE_DELAY_MS = 400;

		async function apiRequest(resource, options) {
			try {
				const response = await fetch(`${API_BASE}${resource}`, {
					method: options?.method ?? 'GET',
					headers:
						options?.body === undefined
							? new Headers()
							: new Headers({ 'content-type': 'application/json' }),
					body: options?.body === undefined ? undefined : JSON.stringify(options.body),
				});
				let body;
				try {
					body = await response.json();
				} catch {
					body = undefined;
				}
				if (!response.ok) return { ok: false, status: response.status, value: body };
				return { ok: true, value: body };
			} catch (error) {
				return { ok: false, status: 0, value: { error: String(error?.message ?? error) } };
			}
		}

		const api = {
			get: (resource) => apiRequest(resource),
			post: (resource, body) => apiRequest(resource, { method: 'POST', body }),
		};

		// ------------------------------------------------------------------
		// 配置缓存（模块级 · 开弹窗不再每次重新拉配置）
		// ------------------------------------------------------------------

		/** 空选项表的共享常量：缓存与组件都复用它，避免每次渲染造新对象。 */
		const EMPTY_OPTIONS = { wavs: [], voices: [] };

		/** 报警配置的**模块级缓存**（模块级 store 形态）。
		 *
		 *  **为什么要有**：`AlarmSettingsCard` 原先每次挂载都自己 `GET config`，于是每次
		 *  点侧栏「报警提醒」都要等一次网络往返，界面上先闪一帧「正在载入报警设置…」
		 *  ——用户实测「点开弹窗很慢、很卡」的第一半就是这个。改成模块级缓存 + `apply()`
		 *  里预加载之后，点开时数据已经在内存里，首帧就是完整表单。
		 *  **不要改回「每次挂载都 fetch」**：那等于把这个卡顿原样装回去。
		 *
		 *  `status` 四态：idle（还没拉过）/ loading（拉取中）/ ok（可用）/ error（上次失败）。
		 *  **整体替换（而不是原地合并）**：订阅方靠引用变化判断「变了没」，
		 *  原地改字段会让 `useState` 的快照永远是同一个对象、重渲染被 React 优化掉。 */
		let configCache = {
			status: 'idle',
			values: null,
			expected: null,
			options: EMPTY_OPTIONS,
			error: null,
		};
		const configCacheListeners = new Set();
		/** 正在飞的请求（并发保护）：多个卡片同时挂载也只发一次 GET。 */
		let configInFlight = null;

		function setConfigCache(patch) {
			configCache = { ...configCache, ...patch };
			for (const listener of [...configCacheListeners]) {
				try {
					listener(configCache);
				} catch {}
			}
		}

		/** 拉一次配置写进缓存并返回最新缓存；**已经在飞就复用同一个 Promise**（不重复发请求）。
		 *  失败不抛错（`apiRequest` 自己把网络异常收成 `ok:false`），只把缓存置 error，
		 *  由调用方决定是「显示错误」还是「下次再试」。 */
		async function refreshConfig() {
			if (configInFlight !== null) return configInFlight;
			setConfigCache({ status: 'loading' });
			configInFlight = (async () => {
				const result = await api.get('config');
				if (result.ok) {
					setConfigCache({
						status: 'ok',
						values: result.value?.values ?? null,
						expected: result.value?.expected ?? result.value?.values ?? null,
						options: result.value?.options ?? EMPTY_OPTIONS,
						error: null,
					});
				} else {
					setConfigCache({ status: 'error', error: result.value?.error ?? result.status });
				}
				return configCache;
			})();
			try {
				return await configInFlight;
			} finally {
				configInFlight = null;
			}
		}

		/** 订阅缓存：缓存一变就重渲染（`useState` + 订阅）。 */
		function useConfigCache() {
			const [snapshot, setSnapshot] = React.useState(configCache);
			React.useEffect(() => {
				const listener = (next) => setSnapshot(next);
				configCacheListeners.add(listener);
				// 首帧与订阅之间若已经变了，补一次，别留空窗。
				if (snapshot !== configCache) setSnapshot(configCache);
				return () => {
					configCacheListeners.delete(listener);
				};
			}, []);
			return snapshot;
		}

		// ------------------------------------------------------------------
		// 字段表
		// ------------------------------------------------------------------

		/** 弹窗风格选项（恰好两种模式：强弹窗 / 系统消息）。 */
		const POPUP_STYLE_OPTIONS = [
			{ value: 'topmost', label: '强弹窗（置顶窗口，自动关闭）' },
			{ value: 'toast', label: '系统消息（Windows 通知）' },
		];

		/** 每条播报文本行共用的帮助文案（是否出声由条件表表头的语音播报总开关决定）。 */
		const VOICE_TEXT_HELP = '由条件表表头的语音播报总开关决定。';

		/** 条件表的列定义（顺序＝每行复选框的顺序，表头与单元格共用同一份）。
		 *  `toggleKey` 是该通道的总开关字段，表头那一行渲染的就是它；
		 *  `toggleLabel` 是表头复选框的可访问名称（「总开关：提醒」）。 */
		const CONDITION_COLUMNS = [
			{ id: 'alert', label: '提醒', toggleKey: 'enabled', toggleLabel: '总开关：提醒' },
			{ id: 'popup', label: '弹窗', toggleKey: 'popup', toggleLabel: '总开关：弹窗' },
			{ id: 'sound', label: '铃声', toggleKey: 'soundEnabled', toggleLabel: '总开关：铃声' },
			{ id: 'voice', label: '语音播报', toggleKey: 'voice', toggleLabel: '总开关：语音播报' },
		];

		/** 表单分区：每区一张小卡片。`rows` 是条件表（每行 4 个复选框），`fields` 是普通字段行。 */
		const SECTIONS = [
			{
				id: 'trigger',
				title: '什么时候提醒',
				desc: '一行一个条件：勾「提醒」表示这个条件会提醒，右边三列决定它用哪几条通道。表头那行是四条通道的总开关，关掉后所有条件都不走这条通道；提醒与通道都要勾上才会真的响。每行最左边的 ▶ 按当前设置试听该条件（只响这一次，不改配置）。',
				rows: [
					{
						kind: 'ask',
						alert: 'alertAsk',
						popup: 'popupAsk',
						sound: 'soundAsk',
						voice: 'voiceAsk',
						label: '需要你裁决（ask_user_question）',
					},
					{
						kind: 'plan',
						alert: 'alertPlan',
						popup: 'popupPlan',
						sound: 'soundPlan',
						voice: 'voicePlan',
						label: '需要你确认计划（exit_plan_mode）',
					},
					{
						kind: 'task-complete',
						alert: 'alertTaskComplete',
						popup: 'popupTaskComplete',
						sound: 'soundTaskComplete',
						voice: 'voiceTaskComplete',
						label: '全部任务完成（任务级完成，不是每轮结束）',
						help: '只在 agent 调用 update_goal（action=complete）时响；普通轮次结束不会响。',
					},
					{
						kind: 'restart',
						alert: 'alertRestart',
						popup: 'popupRestart',
						sound: 'soundRestart',
						voice: 'voiceRestart',
						label: '需要重启 DSH',
						help: 'agent 最后一条消息提到要重启 DSH 时提醒；命中时不再额外响「本轮结束」。默认不弹窗。',
					},
					{
						kind: 'awaiting-test',
						alert: 'alertAwaitingTest',
						popup: 'popupAwaitingTest',
						sound: 'soundAwaitingTest',
						voice: 'voiceAwaitingTest',
						label: '任务到「待人工测试」',
						help: '调度器把任务包推进到待人工测试时提醒（写 03-开发协同/<任务>/状态.md 时识别）。默认开启。',
					},
					{
						kind: 'turn-end',
						alert: 'alertTurnEnd',
						popup: 'popupTurnEnd',
						sound: 'soundTurnEnd',
						voice: 'voiceTurnEnd',
						label: '每一轮结束都提醒',
						help: '默认关闭；勾选后每轮跑完都响一次。默认不弹窗，避免每轮都打断。',
					},
					{
						kind: 'turn-interrupt',
						alert: 'alertTurnInterrupt',
						popup: 'popupTurnInterrupt',
						sound: 'soundTurnInterrupt',
						voice: 'voiceTurnInterrupt',
						label: '本轮中断时提醒（手动打断）',
						help: '默认关闭。',
					},
					{
						kind: 'turn-error',
						alert: 'alertTurnError',
						popup: 'popupTurnError',
						sound: 'soundTurnError',
						voice: 'voiceTurnError',
						label: '本轮报错时提醒（异常结束）',
						help: '默认打开。',
					},
					{
						kind: 'test',
						alert: 'alertTest',
						popup: 'popupTest',
						sound: 'soundTest',
						voice: 'voiceTest',
						label: '手工测试提醒',
						help: '默认开启；取消后这一行的 ▶ 试听也不会响。',
					},
				],
			},
			{
				id: 'batch',
				title: '批量测试协调',
				desc: '多个任务包先开发、最后一起实测时，用这里的规则把提醒收敛成一次。',
				fields: [
					{
						key: 'awaitingTestScope',
						type: 'select',
						label: '待测提醒范围',
						options: [
							{ value: 'all', label: '全部任务各自提醒' },
							{ value: 'anchor', label: '只提醒路径含锚点的那个状态文件' },
						],
						fallback: 'all',
						help: '全部任务各自提醒 / 只提醒路径含「批次锚点」的那个状态文件（配合合并测试批次）',
					},
					{
						key: 'awaitingTestAnchor',
						type: 'text',
						label: '批次锚点关键词',
						help: '状态文件路径里包含该片段才会提醒（不区分大小写），例如 批次、P-U2',
					},
					{
						key: 'awaitingTestQuietSeconds',
						type: 'number',
						label: '待测提醒聚合窗口（秒）',
						min: 0,
						max: 86400,
						step: 1,
						suffix: '秒',
						help: '0 = 每个任务各自提醒；>0 = 窗口内只响第一次，其余累积到窗口结束汇总成一条',
					},
					{
						key: 'awaitingTestSummary',
						type: 'bool',
						label: '汇总附待测清单',
						help: '响时正文列出当前所有待测任务名',
					},
				],
			},
			{
				id: 'popup',
				title: '弹窗',
				fields: [{ key: 'popupStyle', type: 'select', label: '弹窗风格', options: POPUP_STYLE_OPTIONS, fallback: 'topmost' }],
			},
			{
				id: 'sound',
				title: '铃声',
				fields: [
					{ key: 'sound', type: 'select', label: '铃声文件', source: 'wavs', help: '来自 C:\\Windows\\Media 的系统铃声。' },
					{ key: 'soundRepeats', type: 'number', label: '重复次数', min: 1, max: 5, step: 1, suffix: '次' },
				],
			},
			{
				id: 'voice',
				title: '语音播报（TTS）',
				desc: '每条提醒念什么由下面各项定；某条播报文本留空时用最下面的兜底模板。',
				fields: [
					{ key: 'voiceTextAsk', type: 'text', label: '「需要你裁决」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextPlan', type: 'text', label: '「需要你确认计划」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextTaskComplete', type: 'text', label: '「全部任务完成」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextTurnEnd', type: 'text', label: '「每一轮结束」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextInterrupt', type: 'text', label: '「本轮中断」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextError', type: 'text', label: '「本轮报错」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextAwaitingTest', type: 'text', label: '「任务到待人工测试」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextRestart', type: 'text', label: '「需要重启 DSH」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{ key: 'voiceTextTest', type: 'text', label: '「手工测试提醒」播报文本', help: VOICE_TEXT_HELP, wide: true },
					{
						key: 'voiceText',
						type: 'text',
						label: '兜底播报模板',
						help: '上面某条留空时用这条（{title}/{body}）。',
						wide: true,
					},
					{
						key: 'voiceName',
						type: 'select',
						label: '语音',
						source: 'voices',
						emptyLabel: '系统默认语音',
						help: '名字带 Neural 的音色由第三方 VoiceGardenSAPI 提供、需要联网；联网失败时会自动改用本机离线音色。',
					},
					{ key: 'voiceRate', type: 'number', label: '语速', min: -5, max: 5, step: 1, help: '-5 最慢，5 最快。' },
					{ key: 'voiceVolume', type: 'number', label: '音量', min: 0, max: 100, step: 5, suffix: '%' },
				],
			},
			{
				id: 'throttle',
				title: '节流',
				fields: [
					{
						key: 'minTurnSeconds',
						type: 'number',
						label: '只有本轮耗时 ≥（秒）才提醒结束',
						help: '0 = 不限制；只对「本轮结束」生效。',
						min: 0,
						max: 86400,
						step: 1,
						suffix: '秒',
					},
					{
						key: 'throttleSeconds',
						type: 'number',
						label: '同类提醒最小间隔',
						min: 0,
						max: 3600,
						step: 1,
						suffix: '秒',
					},
					{
						key: 'askLatchSeconds',
						type: 'number',
						label: '裁决后忽略「结束」提醒的时长',
						min: 0,
						max: 86400,
						step: 1,
						suffix: '秒',
						help: 'ask 之后紧接着的 idle / turn-end 是同一件事，避免连响两次。',
					},
				],
			},
		];

		// ------------------------------------------------------------------
		// 样式（全部走 DSH 的 CSS 变量，取不到时回落中性色）
		// ------------------------------------------------------------------

		const COLORS = {
			text: 'var(--dsw-alias-text-primary, #1f2328)',
			sub: 'var(--dsw-alias-text-secondary, #57606a)',
			border: 'var(--dsw-alias-border-default, #d0d7de)',
			bg: 'var(--dsw-alias-bg-elevated, #ffffff)',
			field: 'var(--dsw-alias-bg-default, #f6f8fa)',
			accent: 'var(--dsw-alias-accent-default, #0969da)',
			ok: 'var(--dsw-alias-state-success, #1a7f37)',
			bad: 'var(--dsw-alias-state-error, #cf222e)',
		};

		const STYLE = {
			card: {
				border: `1px solid ${COLORS.border}`,
				borderRadius: 10,
				background: COLORS.bg,
				padding: '16px 18px',
				marginBottom: 14,
			},
			cardTitle: { fontSize: 14, fontWeight: 600, color: COLORS.text, margin: '0 0 10px' },
			row: {
				display: 'flex',
				alignItems: 'flex-start',
				gap: 12,
				padding: '7px 0',
				borderTop: `1px solid ${COLORS.border}`,
			},
			label: { flex: '0 0 240px', fontSize: 13, color: COLORS.text, lineHeight: '20px' },
			help: { display: 'block', fontSize: 11.5, color: COLORS.sub, marginTop: 2, lineHeight: '16px' },
			control: { flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 },
			/** 「条件」行：试听列 44px + 标签列 1fr + 四个通道列（各固定 64px）。
			 *  最左的 44px 是每行的「▶ 试听」按钮列（表头那格是空的）；
			 *  四条通道列固定宽度（不随内容变），所以每行复选框与列名严格对齐；
			 *  标签列 minmax(140px, 1fr) 保证窄屏下先收缩换行、列不塌陷
			 *  （四列合计 256px + 44px 试听列 + 间隔，窄屏时表格内部横向滚动，不挤掉标签）。 */
			condRow: {
				display: 'grid',
				gridTemplateColumns: '44px minmax(140px, 1fr) repeat(4, 64px)',
				alignItems: 'start',
				gap: 12,
				padding: '7px 0',
				borderTop: `1px solid ${COLORS.border}`,
			},
			/** 「条件」区列名行（列宽与 condRow 完全一致：试听 + 条件 + 4 条通道）。 */
			condHead: {
				display: 'grid',
				gridTemplateColumns: '44px minmax(140px, 1fr) repeat(4, 64px)',
				alignItems: 'end',
				gap: 12,
				padding: '10px 0 2px',
				fontSize: 11.5,
				color: COLORS.sub,
				lineHeight: '16px',
			},
			/** 条件表的滚动容器：列宽固定、总宽超出时横向滚动，窄屏下标签换行而不塌列。 */
			condTable: { overflowX: 'auto', overscrollBehaviorX: 'contain' },
			condHeadCell: { textAlign: 'center' },
			/** 表头通道单元格里的「总开关复选框 + 列名」：竖排居中对齐，
			 *  外层是 label，点列名也能切换（复选框本身仍带 aria-label）。 */
			condHeadToggle: {
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 2,
				cursor: 'pointer',
			},
			condLabelCell: { minWidth: 0, fontSize: 13, color: COLORS.text, lineHeight: '20px' },
			condCell: { display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, paddingTop: 2 },
			input: {
				width: '100%',
				boxSizing: 'border-box',
				fontSize: 13,
				padding: '5px 8px',
				borderRadius: 6,
				border: `1px solid ${COLORS.border}`,
				background: COLORS.field,
				color: COLORS.text,
				fontFamily: 'inherit',
			},
			number: {
				width: 110,
				boxSizing: 'border-box',
				fontSize: 13,
				padding: '5px 8px',
				borderRadius: 6,
				border: `1px solid ${COLORS.border}`,
				background: COLORS.field,
				color: COLORS.text,
				fontFamily: 'inherit',
			},
			button: {
				fontSize: 13,
				padding: '6px 14px',
				borderRadius: 6,
				border: `1px solid ${COLORS.border}`,
				background: COLORS.field,
				color: COLORS.text,
				cursor: 'pointer',
				fontFamily: 'inherit',
			},
			primary: {
				fontSize: 13,
				padding: '6px 16px',
				borderRadius: 6,
				border: `1px solid ${COLORS.accent}`,
				background: COLORS.accent,
				color: '#ffffff',
				cursor: 'pointer',
				fontFamily: 'inherit',
			},
			status: { fontSize: 12, marginLeft: 10, alignSelf: 'center' },
			suffix: { fontSize: 12, color: COLORS.sub },
		};

		/** 条件行最左列的「▶ 试听」按钮：STYLE.button 的紧凑版（不把行撑高）。 */
		STYLE.auditionButton = {
			...STYLE.button,
			padding: '2px 6px',
			fontSize: 12,
			cursor: 'pointer',
			lineHeight: 1,
		};

		// ------------------------------------------------------------------
		// 小组件
		// ------------------------------------------------------------------

		/** 注入与 DSH 一致的细滚动条样式（只影响本插件自己的滚动区）。 */
		function ensureScrollStyle() {
			const id = 'dsh-alarm-scroll-style';
			if (typeof document === 'undefined' || document.getElementById(id) !== null) return;
			const style = document.createElement('style');
			style.id = id;
			style.textContent = [
				'[data-dsh-alarm-scroll]{scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.42) transparent;scrollbar-gutter:stable}',
				'[data-dsh-alarm-scroll]::-webkit-scrollbar{width:9px;height:9px}',
				'[data-dsh-alarm-scroll]::-webkit-scrollbar-track{background:transparent}',
				'[data-dsh-alarm-scroll]::-webkit-scrollbar-thumb{background:rgba(128,128,128,.4);border-radius:5px;border:2px solid transparent;background-clip:content-box}',
				'[data-dsh-alarm-scroll]::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.62);background-clip:content-box}',
			].join('\n');
			document.head.appendChild(style);
		}

		/** 复选框的可访问名称：取标签里全角括号前的部分（「提醒：需要你裁决」）。
		 *  标签里的括号补充说明是给人看的，念出来太啰嗦，故从 aria-label 里去掉。 */
		function plainLabel(field) {
			const text = String(field.label ?? field.key);
			const cut = text.indexOf('（');
			return cut > 0 ? text.slice(0, cut) : text;
		}

		/** 试听按钮的可访问名称 / 结果提示里用的条件名（「需要你裁决」）。 */
		function auditionLabel(row) {
			return plainLabel({ label: row.label });
		}

		/** 按 kind 从条件表里找回那一行的条件名（试听结果提示用）。 */
		function auditionNameOf(kind) {
			for (const section of SECTIONS) {
				for (const row of section.rows ?? []) {
					if (row.kind === kind) return auditionLabel(row);
				}
			}
			return String(kind);
		}

		/** 条件行里的一个复选框（原生 input，自带键盘可达）。 */
		function ConditionBox(props) {
			const { name, label, checked, onToggle } = props;
			return h('input', {
				type: 'checkbox',
				name,
				'aria-label': label,
				checked: checked === true,
				onChange: (event) => onToggle(event.target.checked),
			});
		}

		/** 「条件」区的列名行（只在条件表里渲染：试听 + 条件 + 四条通道）。
		 *  最左的试听列没有总开关，留空占位（该格 aria-hidden）；
		 *  四个通道列各带一个复选框，它就是这条通道的总开关
		 *  （提醒→enabled、弹窗→popup、铃声→soundEnabled、语音播报→voice）。
		 *  列名文字对读屏是冗余信息（复选框自带「总开关：xx」的 aria-label），只服务于视觉对齐；
		 *  但这一行现在**有**可交互控件，所以不能再整行 aria-hidden。
		 *  **渲染体**：外面包了 `React.memo`（见下方 `ConditionHeaderRow`），别直接当组件用。 */
		function ConditionHeaderRowBody(props) {
			const { values, onChange } = props;
			const cells = [
				// 最左的「试听」列没有总开关，表头留空（纯占位对齐，读屏跳过）。
				h('div', { key: 'audition', style: STYLE.condHeadCell, 'aria-hidden': true }),
				h('div', { key: 'label', style: { ...STYLE.condHeadCell, textAlign: 'left' } }, '条件'),
			];
			for (const column of CONDITION_COLUMNS) {
				cells.push(
					h(
						'div',
						{ key: column.id, style: STYLE.condHeadCell },
						h(
							'label',
							{ style: STYLE.condHeadToggle },
							h(ConditionBox, {
								name: column.toggleKey,
								label: column.toggleLabel,
								checked: values[column.toggleKey] === true,
								onToggle: (next) => onChange(column.toggleKey, next),
							}),
							h('span', null, column.label),
						),
					),
				);
			}
			return h('div', { style: STYLE.condHead }, cells);
		}

		/** 列名行的比较器（`React.memo` 第二参）：只看**四个通道总开关**的布尔值与回调引用。
		 *
		 *  为什么需要：`update()` 改任意一项都会 `{ ...values }` 造新对象，`values` 的引用
		 *  每次都变——不加比较器的话这一行（连同整张表）每勾一下就重建一次。 */
		function conditionHeaderRowEqual(a, b) {
			if (a === b) return true;
			if (a.onChange !== b.onChange) return false;
			const va = a.values ?? {};
			const vb = b.values ?? {};
			for (const column of CONDITION_COLUMNS) {
				if ((va[column.toggleKey] === true) !== (vb[column.toggleKey] === true)) return false;
			}
			return true;
		}

		/** memo 后的列名行（渲染结果与 memo 前完全一致，只跳过无变化的重渲染）。 */
		const ConditionHeaderRow = React.memo(ConditionHeaderRowBody, conditionHeaderRowEqual);

		/** 条件表的一行：▶ 试听按钮 + 条件名（含 help）+ 4 个复选框（提醒 / 弹窗 / 铃声 / 语音播报）。
		 *  最左的 ▶ 用**当前设置**模拟这一行的报警（只响一次，不改配置）；
		 *  四条通道各自独立：提醒决定「这个条件响不响」，另外三列决定「响的时候用哪几条通道」，
		 *  且都还要过对应通道的总开关（就是表头那一行的四个复选框）。
		 *  **渲染体**：外面包了 `React.memo`（见下方 `ConditionRow`），别直接当组件用。 */
		function ConditionRowBody(props) {
			const { row, values, onChange, onAudition, busy } = props;
			// 复选框的可访问名称用整条标签（「弹窗：全部任务完成（任务级完成，不是每轮结束）」），
			// 九个条件的提醒勾选框读起来仍能区分开。
			const name = auditionLabel(row);
			const cells = [];
			for (const column of CONDITION_COLUMNS) {
				const key = row[column.id];
				cells.push(
					h(
						'div',
						{ key: column.id, style: STYLE.condCell },
						h(ConditionBox, {
							name: key,
							label: `${column.label}：${name}`,
							checked: values[key] === true,
							onToggle: (next) => onChange(key, next),
						}),
					),
				);
			}
			return h(
				'div',
				{ style: STYLE.condRow },
				h(
					'div',
					{ key: 'audition', style: STYLE.condCell },
					h(
						'button',
						{
							type: 'button',
							style: STYLE.auditionButton,
							'aria-label': `试听：${name}`,
							title: `试听：${name}`,
							disabled: busy !== '',
							onClick: () => onAudition(row.kind),
						},
						'▶',
					),
				),
				h(
					'div',
					{ style: STYLE.condLabelCell },
					row.label,
					row.help ? h('span', { style: STYLE.help }, row.help) : null,
				),
				cells,
			);
		}

		/** 条件行的比较器（`React.memo` 第二参）：**只有这一行自己那几格变了才重渲染**。
		 *
		 *  为什么需要：勾一下复选框 → `update()` → `{ ...values }` → 整棵树重渲染，
		 *  9 行 × 4 格 + 全部字段行一次全量重建（用户实测「勾选也卡」）。这里按
		 *  「行对象引用 + 该行四个通道键的布尔值 + 回调引用 + busy」比较后，
		 *  勾「弹窗：需要你裁决」只会重渲染那一行。
		 *  键名从 `row[column.id]` 取（`CONDITION_COLUMNS` 的四个 id：alert / popup /
		 *  sound / voice），与渲染时读的是同一份来源，不会两处走偏。
		 *  `onChange` / `onAudition` 都是 `useCallback` 的稳定引用，不会让比较器永远失配。 */
		function conditionRowEqual(a, b) {
			if (a === b) return true;
			if (a.row !== b.row) return false;
			if (a.busy !== b.busy) return false;
			if (a.onChange !== b.onChange) return false;
			if (a.onAudition !== b.onAudition) return false;
			const va = a.values ?? {};
			const vb = b.values ?? {};
			for (const column of CONDITION_COLUMNS) {
				const key = a.row[column.id];
				if ((va[key] === true) !== (vb[key] === true)) return false;
			}
			return true;
		}

		/** memo 后的条件行（渲染结果与 memo 前完全一致，只跳过无变化的重渲染）。 */
		const ConditionRow = React.memo(ConditionRowBody, conditionRowEqual);

		/** 语音下拉的展示：名字带 Neural 的音色由第三方 VoiceGardenSAPI 提供、**需要联网**，
		 *  只在**选项标签**上加后缀说明，value 仍是原始语音名（不污染配置值）。
		 *  判定口径与宿主 lib/voices.js 的 isNetworkVoice 一致。 */
		function voicesWithHint(voices) {
			return (voices ?? []).map((name) => ({
				value: name,
				label: /neural/i.test(name) ? `${name}（需联网）` : name,
			}));
		}

		/** 普通字段行（文本 / 数字 / 下拉）。**渲染体**：外面包了 `React.memo`
		 *  （见下方 `FieldRow`），别直接当组件用。 */
		function FieldRowBody(props) {
			const { field, value, onChange, options } = props;
			const control = [];
			if (field.type === 'bool') {
				control.push(
					h('input', {
						key: 'box',
						type: 'checkbox',
						'aria-label': field.label,
						checked: value === true,
						onChange: (event) => onChange(field.key, event.target.checked),
					}),
				);
			} else if (field.type === 'number') {
				control.push(
					h('input', {
						key: 'num',
						type: 'number',
						style: STYLE.number,
						min: field.min,
						max: field.max,
						step: field.step ?? 1,
						value: value === undefined || value === null ? '' : String(value),
						onChange: (event) => {
							const raw = event.target.value;
							onChange(field.key, raw === '' ? 0 : Number(raw));
						},
					}),
				);
				if (field.suffix) control.push(h('span', { key: 'suffix', style: STYLE.suffix }, field.suffix));
			} else if (field.type === 'select') {
				const list = options ?? field.options ?? [];
				const choices = [];
				if (field.emptyLabel !== undefined) choices.push(h('option', { key: '', value: '' }, field.emptyLabel));
				for (const option of list) {
					const optionValue = typeof option === 'string' ? option : option.value;
					const optionLabel = typeof option === 'string' ? option : option.label;
					choices.push(h('option', { key: optionValue, value: optionValue }, optionLabel));
				}
				const raw = value === undefined || value === null ? '' : String(value);
				const known = list.some((o) => (typeof o === 'string' ? o : o.value) === raw);
				// 读到不在选项内的旧值（如已废弃的 modal / none）时界面回落到 fallback 显示，
				// 且**不写回配置**：用户不动这一项，配置里就保持原值。
				const current = !known && field.fallback !== undefined ? field.fallback : raw;
				const missing = field.emptyLabel === undefined && field.fallback === undefined && raw !== '' && !known;
				if (missing) choices.unshift(h('option', { key: raw, value: raw }, `${raw}（不可用）`));
				control.push(
					h(
						'select',
						{
							key: 'select',
							style: STYLE.input,
							value: current,
							onChange: (event) => onChange(field.key, event.target.value),
						},
						choices,
					),
				);
			} else {
				control.push(
					h('input', {
						key: 'text',
						type: 'text',
						style: STYLE.input,
						value: value === undefined || value === null ? '' : String(value),
						onChange: (event) => onChange(field.key, event.target.value),
					}),
				);
			}
			return h(
				'div',
				{ style: STYLE.row },
				h(
					'div',
					{ style: STYLE.label },
					field.label,
					field.help ? h('span', { style: STYLE.help }, field.help) : null,
				),
				h('div', { style: STYLE.control }, control),
			);
		}

		/** 字段行的比较器（`React.memo` 第二参）：`field` / `options` 按**引用**比。
		 *
		 *  为什么需要：改一个字段会让整棵树重渲染，十几个字段行（含带长 help 文本的）
		 *  全部重建。按引用比较后，只有真正变了的那一行会重渲染。
		 *  `options` 必须是稳定引用——`voicesWithHint()` 的结果在 `AlarmSettingsCard`
		 *  里用 `React.useMemo` 按 `options.voices` 缓存后传进来（别在渲染里新建数组，
		 *  否则这里永远失配、memo 白加）。 */
		function fieldRowEqual(a, b) {
			if (a === b) return true;
			return a.field === b.field && a.value === b.value && a.onChange === b.onChange && a.options === b.options;
		}

		/** memo 后的字段行（渲染结果与 memo 前完全一致，只跳过无变化的重渲染）。 */
		const FieldRow = React.memo(FieldRowBody, fieldRowEqual);

		/** 渲染一个分区的主体：条件表在前（列名行 + 每行 ▶ 试听 + 4 个复选框，窄屏横向滚动），
		 *  普通字段行在后（顺序＝SECTIONS 里 fields 的顺序）。
		 *  `voiceChoices` 是**调用方 `useMemo` 缓存好的**语音选项（带「需联网」后缀）：
		 *  这里绝不能现算 `voicesWithHint(options.voices)`——每次渲染都造新数组会让
		 *  `FieldRow` 的 `options` 引用一直变，那边刚加上的 memo 就全部失配了。 */
		function renderSectionBody(section, values, update, options, audition, busy, voiceChoices) {
			const nodes = [];
			const conditionRows = [];
			for (const row of section.rows ?? []) {
				conditionRows.push(
					h(ConditionRow, {
						key: `cond-${row.alert}`,
						row,
						values,
						onChange: update,
						onAudition: audition,
						busy,
					}),
				);
			}
			if (conditionRows.length > 0) {
				nodes.push(
					h(
						'div',
						{ key: `${section.id}-table`, style: STYLE.condTable },
						h(ConditionHeaderRow, { key: 'head', values, onChange: update }),
						conditionRows,
					),
				);
			}
			for (const field of section.fields ?? []) {
				nodes.push(
					h(FieldRow, {
						key: field.key,
						field,
						value: values[field.key],
						onChange: update,
						options:
							field.source === 'wavs'
								? options.wavs
								: field.source === 'voices'
									? voiceChoices
									: undefined,
					}),
				);
			}
			return nodes;
		}

		/** 设置卡片：设置页与「插件」页共用。
		 *
		 *  `fill === true` 时卡片自己撑满父容器、标题行固定、正文单独滚动
		 *  （弹窗里用）；不传则保持「一页长卡片」的老样子（设置页 / 插件页）。
		 *  标题行**不用** `position:'sticky'`——sticky 依赖滚动容器的祖先链，
		 *  宿主侧的 overflow/transform 一干预就失效，实测会跟着正文一起滚走。
		 *
		 *  **数据来源改成模块级缓存**（`configCache` + `refreshConfig()`，见文件上半部分）：
		 *  原先这里 `useState(null)` + `useEffect(load)` 等于「每次挂载都拉一次配置」，
		 *  于是每次点开弹窗都要先闪一帧「正在载入报警设置…」。现在首帧直接吃缓存，
		 *  只有缓存**没就绪**时才去拉——这是「点开即显示」的关键，别改回去。 */
		function AlarmSettingsCard({ onRequestClose, fill }) {
			const { useState, useEffect, useCallback, useRef, useMemo } = React;
			/** 缓存快照：只在「挂载时缓存还没就绪、之后才就绪」这条路上用到（见下面的采纳 effect）。 */
			const cache = useConfigCache();
			/** 缓存已就绪＝首帧就有完整表单（`apply()` 已预加载，用户点开时通常就是这样）。 */
			const warm = configCache.status === 'ok';
			const [values, setValues] = useState(warm ? configCache.values : null);
			const [expected, setExpected] = useState(warm ? configCache.expected ?? configCache.values : null);
			const [options, setOptions] = useState(warm ? configCache.options : EMPTY_OPTIONS);
			const [busy, setBusy] = useState('');
			const [status, setStatus] = useState(null);
			const [error, setError] = useState(null);

			/** 自动保存的防抖定时器（卸载/重新载入时清掉未触发的那一次）。 */
			const autoSaveTimer = useRef(null);
			/** 页面当前状态与「已保存快照」的镜像：防抖回调与试听都从这里读，
			 *  否则 useCallback 的闭包会拿着上一次渲染的旧 values（连点勾选时必然出错）。
			 *  热缓存下必须**同步**用缓存值初始化：否则首帧就有内容、`update()` 却因为
			 *  `latestValues.current === null` 直接返回，勾了没反应。 */
			const latestValues = useRef(warm ? configCache.values : null);
			const latestExpected = useRef(warm ? configCache.expected ?? configCache.values : null);

			/** 清掉还没触发的自动保存。 */
			const cancelAutoSave = useCallback(() => {
				if (autoSaveTimer.current !== null) {
					clearTimeout(autoSaveTimer.current);
					autoSaveTimer.current = null;
				}
			}, []);

			/** 写页面状态（同时刷新 ref 镜像）。 */
			const applyValues = useCallback((next) => {
				latestValues.current = next;
				setValues(next);
			}, []);

			/** 写「已保存快照」（乐观并发的 expected，同时刷新 ref 镜像）。 */
			const applyExpected = useCallback((next) => {
				latestExpected.current = next;
				setExpected(next);
			}, []);

			/** 从宿主重新读一次配置写进缓存，再把结果铺到页面状态上。
			 *  「重新载入」按钮与「缓存没就绪时的首次加载」共用这一条路径。 */
			const load = useCallback(async () => {
				cancelAutoSave();
				const next = await refreshConfig();
				if (next.status !== 'ok') {
					setError(`读取配置失败：${next.error ?? '未知错误'}`);
					return;
				}
				applyValues(next.values ?? null);
				applyExpected(next.expected ?? next.values ?? null);
				setOptions(next.options ?? EMPTY_OPTIONS);
				setError(null);
			}, [applyExpected, applyValues, cancelAutoSave]);

			/** **只在缓存没就绪时**才拉：热缓存下这里什么都不做，弹窗首帧就是完整表单。
			 *  （读 `configCache` 而不是依赖 `cache`：这是「此刻要不要发请求」的判断，
			 *  不需要因为缓存变化而重跑。） */
			useEffect(() => {
				if (configCache.status === 'ok') return;
				void load();
			}, [load]);

			/** 缓存比本卡片**晚**就绪时（冷启动、或预加载还在飞）把数据补进页面状态。
			 *  只在本地还没有数据时采纳——用户已经改过的内容绝不能被缓存覆盖。 */
			useEffect(() => {
				if (latestValues.current !== null) return;
				if (cache.status !== 'ok') return;
				applyValues(cache.values ?? null);
				applyExpected(cache.expected ?? cache.values ?? null);
				setOptions(cache.options ?? EMPTY_OPTIONS);
				setError(null);
			}, [cache, applyExpected, applyValues]);

			/** 卸载时清掉未触发的定时器（别让组件已经没了还去 POST）。 */
			useEffect(
				() => () => {
					cancelAutoSave();
				},
				[cancelAutoSave],
			);

			/** 把一份 values 提交给宿主：手动保存与自动保存共用同一条路径。
			 *  `mode === 'auto'` 时提示更轻（409 不叫用户再点保存），
			 *  且**不回写 values**——自动保存返回时用户可能已经在改下一项了。 */
			const persist = useCallback(
				async (valuesToSave, mode) => {
					if (valuesToSave === null || valuesToSave === undefined) return;
					const auto = mode === 'auto';
					// 自动保存不占用 busy：busy 会把每行的 ▶ 按钮置灰（`disabled: busy !== ''`），
					// 刚勾完就去点试听会点不动——那正是这次要修掉的坑，不能换个地方再犯。
					if (!auto) {
						setBusy('save');
						setStatus(null);
					}
					const result = await api.post('config', { expected: latestExpected.current, values: valuesToSave });
					if (result.ok) {
						const saved = result.value?.values ?? valuesToSave;
						const savedExpected = result.value?.expected ?? saved;
						const savedOptions = result.value?.options ?? configCache.options;
						if (!auto) applyValues(saved);
						applyExpected(savedExpected);
						setOptions(savedOptions);
						// 回写缓存：下次开弹窗（或设置页 / 插件页的卡片）直接拿到刚保存的值，
						// 不用再等一次 GET。缓存与页面状态在这里是**同一份**数据，别只更新一边。
						setConfigCache({
							status: 'ok',
							values: saved,
							expected: savedExpected,
							options: savedOptions,
							error: null,
						});
						setError(null);
						setStatus({ kind: 'ok', text: '已保存' });
					} else if (result.status === 409) {
						const fresh = result.value?.values ?? null;
						if (fresh !== null) {
							applyValues(fresh);
							applyExpected(fresh);
							// 409 时宿主已经把磁盘上的新值给了我们，缓存也必须跟着换，
							// 否则下次开弹窗又会显示冲突前的旧值。
							setConfigCache({ status: 'ok', values: fresh, expected: fresh, error: null });
						}
						setStatus({
							kind: 'bad',
							text: auto
								? '配置已被其它窗口修改，已重新载入。'
								: '配置已被其它窗口修改，已重新载入，请再保存一次。',
						});
					} else {
						setStatus({ kind: 'bad', text: `保存失败：${result.value?.error ?? result.status}` });
					}
					if (!auto) setBusy('');
				},
				[applyExpected, applyValues],
			);

			/** 勾选即存：400ms 防抖，连续勾选只发一次 POST。 */
			const scheduleAutoSave = useCallback(
				(nextValues) => {
					cancelAutoSave();
					autoSaveTimer.current = setTimeout(() => {
						autoSaveTimer.current = null;
						void persist(nextValues, 'auto');
					}, AUTO_SAVE_DELAY_MS);
				},
				[cancelAutoSave, persist],
			);

			/** 改一项：立刻更新页面状态，并排一次自动保存。 */
			const update = useCallback(
				(key, next) => {
					const previous = latestValues.current;
					if (previous === null) return;
					const updated = { ...previous, [key]: next };
					applyValues(updated);
					scheduleAutoSave(updated);
				},
				[applyValues, scheduleAutoSave],
			);

			/** 底部「保存」按钮：手动重试入口（自动保存失败、或想立刻落盘时用）。 */
			const save = useCallback(() => {
				cancelAutoSave();
				void persist(latestValues.current, 'manual');
			}, [cancelAutoSave, persist]);

			/** 试听某一行的条件：按**页面当前勾选**（含还没保存的改动）让宿主立刻模拟一次。
			 *  `kind` 就是条件表里那一行的 kind（ask / plan / task-complete / … / test）。
			 *  values 必须一起发：否则宿主只能用磁盘上的旧配置去响——「勾了语音还没保存
			 *  就点 ▶ 听不到 TTS」就是这么来的。 */
			const audition = useCallback(async (kind) => {
				setBusy(`audition:${kind}`);
				setStatus(null);
				const name = auditionNameOf(kind);
				const result = await api.post('test', { kind, values: latestValues.current });
				if (result.ok) {
					const delivered = result.value?.delivered !== false;
					const started = result.value?.scriptStarted !== false;
					if (!delivered) {
						setStatus({ kind: 'bad', text: '没有响：总开关、该条件或它用到的通道是关的（看条件表勾选）' });
					} else if (!started) {
						setStatus({ kind: 'bad', text: '已投递，但报警脚本没真正启动——请重启 DSH 后再试。' });
					} else {
						setStatus({ kind: 'ok', text: `已按当前设置试听：${name}` });
					}
				} else {
					setStatus({ kind: 'bad', text: `试听失败：${result.value?.error ?? result.status}` });
				}
				setBusy('');
			}, []);

			/** 语音下拉的选项（名字带 Neural 的加「需联网」后缀）。按 `options.voices` 的**引用**
			 *  缓存：每次渲染都新建数组会让 `FieldRow` 的 `options` 引用一直变，
			 *  那边刚加上的 `React.memo` 就全部失配（等于没加）。 */
			const voiceChoices = useMemo(() => voicesWithHint(options.voices), [options.voices]);

			if (error !== null && values === null) {
				return h('div', { style: STYLE.card }, h('p', { style: { color: COLORS.bad, fontSize: 13 } }, error));
			}
			if (values === null) {
				return h('div', { style: STYLE.card }, h('p', { style: { color: COLORS.sub, fontSize: 13 } }, '正在载入报警设置…'));
			}

			const sections = SECTIONS.map((section) =>
				h(
					'div',
					{ key: section.id, style: STYLE.card },
					h('h3', { style: STYLE.cardTitle }, section.title),
					section.desc
						? h(
								'p',
								{ style: { margin: '0 0 6px', fontSize: 12, color: COLORS.sub, lineHeight: '17px' } },
								section.desc,
							)
						: null,
					renderSectionBody(section, values, update, options, audition, busy, voiceChoices),
				),
			);

			// 标题行 = 固定头：不参与滚动，`flex:'0 0 auto'` 保证不被正文压扁。
			const headerRow = h(
				'div',
				{ style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: '0 0 auto', marginTop: 0, marginBottom: 10, background: COLORS.bg, paddingTop: 10, paddingBottom: 10, borderBottom: `1px solid ${COLORS.border}` } },
				// 标题在最左，`marginRight:'auto'` 把右边那组按钮（编辑报警规则 / 重新载入 / 保存 / ❌）
				// 整组推到行尾。
				h(
					'span',
					{ style: { fontSize: 15, fontWeight: 600, color: COLORS.text, marginRight: 'auto' } },
					'报警提醒',
				),
				// 「编辑报警规则」放在「重新载入」**之前**（用户指定的位置）：它只是「看 + 复制」
				// 规则的入口，不改配置；后面才是重新载入 / 保存 / ❌ 这组改配置的按钮。
				// 四个入口（浮层弹窗 / 设置页 / 插件页 / 侧栏）都渲染同一张卡片，所以都会出现它。
				h(
					'button',
					{
						type: 'button',
						style: STYLE.button,
						title: '编辑报警规则',
						'aria-label': '编辑报警规则',
						onClick: () => setRulesDialogOpen(true),
					},
					'编辑报警规则',
				),
				h('button', { type: 'button', style: STYLE.button, disabled: busy !== '', onClick: load }, '重新载入'),
				h('button', { type: 'button', style: STYLE.primary, disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : '保存'),
				status !== null
					? h(
							'span',
							{ style: { ...STYLE.status, color: status.kind === 'ok' ? COLORS.ok : COLORS.bad } },
							status.text,
						)
					: null,
				// ❌ 始终是这一行的最后一个元素；不再自己带 marginLeft:'auto'（标题已经撑开了）。
				typeof onRequestClose === 'function'
					? h(
							'button',
							{
								type: 'button',
								title: '关闭',
								'aria-label': '关闭报警提醒',
								onClick: onRequestClose,
								style: { ...STYLE.button },
							},
							'❌',
						)
					: null,
			);

			// 滚动体：只有 fill 上下文才限高并自己滚（标题行因此永远不动）；
			// 其它入口 style 为 null，保持「一页长卡片、由外层页面滚动」的老样子。
			const scrollBody = h(
				'div',
				{
					'data-dsh-alarm-scroll': fill ? '1' : undefined,
					style: fill
						? { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain' }
						: null,
				},
				sections,
			);

			return h(
				'div',
				{ style: fill ? { display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '100%' } : null },
				headerRow,
				scrollBody,
			);
		}

		/** 设置弹窗：遮罩 + 居中卡片（fixed 定位）。
		 *
		 *  **只由 `shell.overlay` 槽位里的 `AlarmDialogLayer` 渲染**（宿主官方浮层容器，
		 *  不再用 portal）。侧边栏铃铛只是置「要弹窗」的标志，真正的浮层永远只有这一个实例。
		 *  关闭统一走 onRequestClose，由调用方决定是「收起弹窗」还是「切回会话界面」。 */
		function AlarmDialog({ onRequestClose, title }) {
			const heading = title ?? '报警提醒';
			/** 关闭的最后一道保险：**不依赖调用方**。
			 *
			 *  `onRequestClose` 可能根本不存在、可能抛错、宿主也可能不认「收起弹窗」
			 *  这件事（`ctx.layout.selectPanel` 未必有）。所以本组件自己记「已关闭」，
			 *  置位后本组件直接不渲染任何东西——宿主收不收都无所谓，用户点了 ❌
			 *  窗口就必然消失。 */
			const [closed, setClosed] = React.useState(false);
			const close = React.useCallback(() => {
				setClosed(true);
				try {
					onRequestClose?.();
				} catch {}
			}, [onRequestClose]);

			React.useEffect(() => {
				ensureScrollStyle();
			}, []);

			/** Esc 关闭：只在弹窗挂着时监听，卸载时移除。 */
			React.useEffect(() => {
				if (typeof document === 'undefined') return undefined;
				const onKeyDown = (event) => {
					if (event?.key === 'Escape' || event?.key === 'Esc') {
						event.preventDefault?.();
						close();
					}
				};
				document.addEventListener('keydown', onKeyDown);
				return () => document.removeEventListener('keydown', onKeyDown);
			}, [close]);

			// 所有 hook 都已经跑过（React 规则），这里才允许提前返回。
			if (closed) return null;

			const dialogNode = h(
				'div',
				{
					// 遮罩：点空白处关闭（卡片上的 onClick 会 stopPropagation 拦下）。
					style: {
						position: 'fixed',
						inset: 0,
						background: 'rgba(0,0,0,0.35)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						zIndex: 9999,
					},
					onClick: close,
				},
				h(
					'div',
					{
						role: 'dialog',
						'aria-modal': true,
						'aria-label': heading,
						// 点卡片内部不关闭。
						onClick: (event) => event?.stopPropagation?.(),
						// 卡片自己**不滚**：只做「撑满 + 纵向 flex 容器」，滚动交给卡片内的
						// 滚动体（`AlarmSettingsCard` 的 fill 结构）。这样标题行永远在顶部。
						style: {
							boxSizing: 'border-box',
							maxWidth: '900px',
							width: 'calc(100vw - 48px)',
							maxHeight: '86vh',
							overflow: 'hidden',
							display: 'flex',
							flexDirection: 'column',
							border: `1px solid ${COLORS.border}`,
							borderRadius: 12,
							background: COLORS.bg,
							color: COLORS.text,
							boxShadow: '0 18px 48px rgba(0,0,0,0.32)',
							padding: '14px 18px 18px',
						},
					},
					h(AlarmSettingsCard, { onRequestClose: close, fill: true }),
				),
			);

			return dialogNode;
		}

		/** 「设置弹窗应该打开」的模块级标志 + 极小订阅。
		 *
		 *  唯一的入口（侧边栏铃铛）只是把这个标志置 true；真正的浮层由
		 *  `shell.overlay` 槽位里的 `AlarmDialogLayer` 渲染，全页只有一个实例。
		 *  订阅机制只为了让「层已经挂着」时也能立刻收到通知（模块级变量本身不触发重渲染）。 */
		let iconDialogOpen = false;
		const iconDialogListeners = new Set();

		function setIconDialogOpen(next) {
			const value = next === true;
			if (iconDialogOpen === value) return;
			iconDialogOpen = value;
			for (const listener of [...iconDialogListeners]) {
				try {
					listener(value);
				} catch {}
			}
		}

		/** 订阅上面的标志：返回当前值，变化时触发一次重渲染。 */
		function useIconDialogOpen() {
			const [isOpen, setIsOpen] = React.useState(iconDialogOpen);
			React.useEffect(() => {
				iconDialogListeners.add(setIsOpen);
				// 首帧与订阅之间若有变化，补一次，别留下空窗。
				if (isOpen !== iconDialogOpen) setIsOpen(iconDialogOpen);
				return () => {
					iconDialogListeners.delete(setIsOpen);
				};
			}, []);
			return isOpen;
		}

		/** 「编辑报警规则」弹窗的模块级标志 + 订阅：**与 `iconDialogOpen` 完全并列的另一套**。
		 *
		 *  为什么不复用上面那套：两个弹窗是**独立开关**（规则块可能在四个入口的任意一处打开，
		 *  关闭时也不该把侧栏那套设置浮层的状态一起改掉）。两套各自一份订阅，
		 *  互不干扰；`iconDialogOpen` 那一套一个字都没动。 */
		let rulesDialogOpen = false;
		const rulesDialogListeners = new Set();

		function setRulesDialogOpen(next) {
			const value = next === true;
			if (rulesDialogOpen === value) return;
			rulesDialogOpen = value;
			for (const listener of [...rulesDialogListeners]) {
				try {
					listener(value);
				} catch {}
			}
		}

		/** 订阅「编辑报警规则」标志：返回当前值，变化时触发一次重渲染。 */
		function useRulesDialogOpen() {
			const [isOpen, setIsOpen] = React.useState(rulesDialogOpen);
			React.useEffect(() => {
				rulesDialogListeners.add(setIsOpen);
				// 首帧与订阅之间若有变化，补一次，别留下空窗。
				if (isOpen !== rulesDialogOpen) setIsOpen(rulesDialogOpen);
				return () => {
					rulesDialogListeners.delete(setIsOpen);
				};
			}, []);
			return isOpen;
		}

		/** 侧边栏图标（一支小铃铛）：**整行可点**，弹设置浮层，不切走主界面。
		 *
		 *  这里**只置标志**、不渲染弹窗：浮层统一由 `shell.overlay` 槽位负责
		 *  （见 AlarmDialogLayer）。任何地方内联渲染 AlarmDialog 都会出现第二个弹窗。
		 *  本插件**不注册 main 槽位**，所以宿主没有「报警提醒」这个可选主面板，
		 *  主区域永远停在会话界面。
		 *
		 *  **为什么监听挂在宿主那一行上、而不是挂在自己的 span 上**：宿主把
		 *  `sidebar.panellist` 的每个条目渲染成一个 `<button>` 行——图标位里放我们的
		 *  组件，行里的文字 label（「报警提醒」）由外壳自己渲染。只挂自己的 span 时，
		 *  点图标能开设置、点文字却落在宿主的 button 上、走「选中面板」那条路；
		 *  而本插件没有 main 面板，于是点了什么都不发生（用户实测：只有点铃铛才有反应）。
		 *  所以用 `rowRef.current` 向上找最近的宿主 button 行（见下方 effect），在**捕获阶段**拦下
		 *  click，让整行（含文字）都进设置浮层。别改回只挂 span。
		 *  `ctx` 现在**用不到了**（打开路径不再调 `selectPanel`，见下面 onRowClick 的注释）；
		 *  签名保留是为了与其它槽位组件保持同一形态（`apply()` 统一传 `ctx`）。 */
		function AlarmPanelIcon({ ctx }) {
			const rowRef = React.useRef(null);

			/** 整行可点 = 在宿主 button 上挂捕获监听（只挂自己的 span 时点 label 无效）。 */
			React.useEffect(() => {
				const row = rowRef.current?.closest('button');
				// 宿主结构变了（不再用 button 包一行）也不能崩：退化成「只有图标区域可点」。
				if (!row) return undefined;
				/** 拦掉「选中面板」这一跳转。
				 *
				 *  **这里不再调 `ctx.layout.selectPanel(null)`**（原先是「保险」）：点击已经被
				 *  上面的 `stopPropagation` 在捕获阶段拦下，宿主的 onClick 根本不会跑、主区域
				 *  也不会切走，那次调用纯属白付——它会同步触发一次宿主整体重排，正是用户
				 *  实测「点开弹窗又慢又卡」的第三份开销。关闭路径（`AlarmDialogLayer`）里
				 *  的那次 `selectPanel(null)` **保留**：那里确实需要把主区域拉回会话。 */
				const onRowClick = (event) => {
					event?.preventDefault?.();
					event?.stopPropagation?.();
					// 同步置位：overlay 层下一帧就能收到。
					setIconDialogOpen(true);
				};
				// 捕获阶段（第三参 true）：必须抢在宿主 button 自己的 onClick 之前拦下，
				// 否则主区域会被切走（本插件没有 main 面板，切走就是白板）。
				row.addEventListener('click', onRowClick, true);
				// 行上留下的痕迹先存原值，卸载时原样还回去，别留脏。
				const previousCursor = row.style ? row.style.cursor : undefined;
				const previousAriaLabel = row.getAttribute?.('aria-label') ?? null;
				const previousTitle = row.getAttribute?.('title') ?? null;
				if (row.style) row.style.cursor = 'pointer';
				row.setAttribute('aria-label', '打开报警提醒设置');
				row.setAttribute('title', '打开报警提醒设置');
				return () => {
					row.removeEventListener('click', onRowClick, true);
					if (row.style) row.style.cursor = previousCursor ?? '';
					if (previousAriaLabel === null) row.removeAttribute?.('aria-label');
					else row.setAttribute('aria-label', previousAriaLabel);
					if (previousTitle === null) row.removeAttribute?.('title');
					else row.setAttribute('title', previousTitle);
				};
			}, []);

			/** 图标自己卸载（宿主重建侧栏）时清掉标志，别把 main 面板永久挡在门外。 */
			React.useEffect(
				() => () => {
					setIconDialogOpen(false);
				},
				[],
			);

			return h(
				'span',
				{
					ref: rowRef,
					// 纯装饰：可点/可聚焦/键盘可达性都由宿主那一行 button 承担
					// （它本身可聚焦，Enter 会触发 click，被上面的捕获监听接住）。
					'aria-hidden': 'true',
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						borderRadius: 6,
						padding: 2,
					},
				},
				h(
					'svg',
					{ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
					h('path', {
						d: 'M12 3a6 6 0 0 0-6 6v3.6L4.6 16.2A1 1 0 0 0 5.5 17.7h13a1 1 0 0 0 .9-1.5L18 12.6V9a6 6 0 0 0-6-6Z',
						stroke: 'currentColor',
						strokeWidth: 1.6,
						strokeLinejoin: 'round',
					}),
					h('path', {
						d: 'M9.8 20.2a2.4 2.4 0 0 0 4.4 0',
						stroke: 'currentColor',
						strokeWidth: 1.6,
						strokeLinecap: 'round',
					}),
				),
			);
		}

		/** 弹窗层：`shell.overlay` 槽位里**唯一**渲染 AlarmDialog 的地方。
		 *
		 *  改走宿主官方浮层槽位、不再用 portal 挂 body：portal 那条路
		 *  一出现就白屏（用户实测），槽位是宿主自己管理的浮层容器，稳定。
		 *  开关仍由模块级标志 `iconDialogOpen` 驱动（侧栏铃铛只置它）。 */
		function AlarmDialogLayer({ ctx }) {
			const isOpen = useIconDialogOpen();
			if (!isOpen) return null;
			const onRequestClose = () => {
				setIconDialogOpen(false);
				// selectPanel 不认 null 之外的未知 id，会抛错，故 try/catch。
				try {
					ctx?.layout?.selectPanel?.(null);
				} catch {}
			};
			return h(AlarmDialog, { onRequestClose });
		}

		/** 「编辑报警规则」弹窗：一个只读的规则块 + 一键复制。
		 *
		 *  正文来自宿主只读路由 `GET api/dsh-alarm/agent-rules`（唯一起源是插件自带的
		 *  `docs/agent-output-prompt.md` 里第一个 ```text 块）——**前端不内联任何规则文本**，
		 *  否则文档一改界面就撒谎。
		 *  视觉沿用 `AlarmDialog`：同一套遮罩 / 居中卡片 / 卡片内不滚（滚的是 textarea）。
		 *  关闭：Esc / 点 ❌ / 点遮罩；点卡片内部 stopPropagation 不关。 */
		function RulesDialog({ onRequestClose }) {
			const { useState, useEffect, useRef, useCallback } = React;
			/** 规则正文 / 文件缺失 / 读取失败 / 复制反馈（idle | copied | failed）。 */
			const [text, setText] = useState('');
			const [missing, setMissing] = useState(false);
			const [error, setError] = useState(null);
			const [copyState, setCopyState] = useState('idle');
			/** 「重新载入」用：递增即重新拉一次（作为拉取 effect 的依赖）。 */
			const [reloadSeq, setReloadSeq] = useState(0);
			const textareaRef = useRef(null);
			/** 「已复制」1.5 秒后回落的定时器句柄（卸载时清掉）。 */
			const copyTimer = useRef(null);

			/** 拉规则块：打开时自动拉一次；点「重新载入」再拉。 */
			useEffect(() => {
				let alive = true;
				setError(null);
				void (async () => {
					const result = await api.get('agent-rules');
					// 关掉弹窗/卸载后回来的响应直接丢掉，别给已卸载组件 setState。
					if (!alive) return;
					if (!result.ok) {
						setError(`读取规则失败：${result.value?.error ?? result.status}`);
						return;
					}
					if (result.value?.missing === true) {
						setMissing(true);
						setText('');
						return;
					}
					setMissing(false);
					setText(String(result.value?.text ?? ''));
				})();
				return () => {
					alive = false;
				};
			}, [reloadSeq]);

			/** 卸载时清掉「已复制」定时器（组件没了还改状态会打印告警）。 */
			useEffect(
				() => () => {
					if (copyTimer.current !== null) {
						clearTimeout(copyTimer.current);
						copyTimer.current = null;
					}
				},
				[],
			);

			/** 一键复制：优先 Clipboard API；不可用/被拒时回退「选中 textarea + execCommand('copy')」。
			 *  受限 webview 或非安全上下文里 Clipboard API 常常不存在，这条回退是必需的。 */
			const copy = useCallback(async () => {
				const value = String(textareaRef.current?.value ?? text ?? '');
				let done = false;
				try {
					const clipboard = typeof navigator === 'undefined' ? undefined : navigator?.clipboard;
					if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
						await clipboard.writeText(value);
						done = true;
					}
				} catch {
					done = false;
				}
				if (!done) {
					try {
						const node = textareaRef.current;
						node?.focus?.();
						node?.select?.();
						node?.setSelectionRange?.(0, value.length);
						done = typeof document !== 'undefined' && document.execCommand?.('copy') === true;
					} catch {
						done = false;
					}
				}
				if (copyTimer.current !== null) {
					clearTimeout(copyTimer.current);
					copyTimer.current = null;
				}
				if (done) {
					setCopyState('copied');
					copyTimer.current = setTimeout(() => {
						copyTimer.current = null;
						setCopyState('idle');
					}, 1500);
				} else {
					setCopyState('failed');
				}
			}, [text]);

			/** Esc 关闭：只在弹窗挂着时监听，卸载时移除。 */
			useEffect(() => {
				if (typeof document === 'undefined') return undefined;
				const onKeyDown = (event) => {
					if (event?.key === 'Escape' || event?.key === 'Esc') {
						event.preventDefault?.();
						onRequestClose?.();
					}
				};
				document.addEventListener('keydown', onKeyDown);
				return () => document.removeEventListener('keydown', onKeyDown);
			}, [onRequestClose]);

			const hints = [];
			if (missing) {
				hints.push(
					h(
						'div',
						{ key: 'missing', style: { fontSize: 12, color: COLORS.bad, marginBottom: 6 } },
						'规则文件缺失（docs/agent-output-prompt.md），请检查插件完整性',
					),
				);
			}
			if (error !== null) {
				hints.push(
					h(
						'div',
						{
							key: 'error',
							style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: COLORS.bad, marginBottom: 6 },
						},
						h('span', null, error),
						h(
							'button',
							{ type: 'button', style: STYLE.auditionButton, onClick: () => setReloadSeq((seq) => seq + 1) },
							'重新载入',
						),
					),
				);
			}
			if (copyState === 'failed') {
				hints.push(
					h(
						'div',
						{ key: 'copy-failed', style: { fontSize: 12, color: COLORS.bad, marginBottom: 6 } },
						'复制失败，请手动全选复制',
					),
				);
			}

			return h(
				'div',
				{
					// 遮罩：点空白处关闭（卡片上的 onClick 会 stopPropagation 拦下）。
					style: {
						position: 'fixed',
						inset: 0,
						background: 'rgba(0,0,0,0.35)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						zIndex: 9999,
					},
					onClick: onRequestClose,
				},
				h(
					'div',
					{
						role: 'dialog',
						'aria-modal': true,
						'aria-label': '编辑报警规则',
						// 点卡片内部不关闭。
						onClick: (event) => event?.stopPropagation?.(),
						style: {
							boxSizing: 'border-box',
							maxWidth: '900px',
							width: 'calc(100vw - 48px)',
							maxHeight: '86vh',
							overflow: 'hidden',
							display: 'flex',
							flexDirection: 'column',
							border: `1px solid ${COLORS.border}`,
							borderRadius: 12,
							background: COLORS.bg,
							color: COLORS.text,
							boxShadow: '0 18px 48px rgba(0,0,0,0.32)',
							padding: '14px 18px 18px',
						},
					},
					// 头部：标题 + 一键复制 + ❌。
					h(
						'div',
						{
							style: {
								display: 'flex',
								alignItems: 'center',
								gap: 10,
								flex: '0 0 auto',
								marginBottom: 10,
								paddingBottom: 10,
								borderBottom: `1px solid ${COLORS.border}`,
							},
						},
						h(
							'span',
							{ style: { fontSize: 15, fontWeight: 600, color: COLORS.text, marginRight: 'auto' } },
							'编辑报警规则',
						),
						h(
							'button',
							{
								type: 'button',
								style: STYLE.button,
								title: '一键复制',
								'aria-label': '一键复制',
								onClick: () => {
									void copy();
								},
							},
							copyState === 'copied' ? '已复制' : '一键复制',
						),
						h(
							'button',
							{
								type: 'button',
								style: STYLE.button,
								title: '关闭',
								'aria-label': '关闭报警规则',
								onClick: onRequestClose,
							},
							'❌',
						),
					),
					hints.length > 0 ? h('div', { style: { flex: '0 0 auto' } }, hints) : null,
					// 正文：只读 textarea（可纵向拉伸；规则块里的换行原样保留）。
					h('textarea', {
						ref: textareaRef,
						readOnly: true,
						spellCheck: false,
						'aria-label': '报警规则',
						value: text,
						style: {
							flex: '1 1 auto',
							minHeight: 0,
							width: '100%',
							boxSizing: 'border-box',
							resize: 'vertical',
							fontFamily: 'ui-monospace,Consolas,monospace',
							fontSize: 12.5,
							lineHeight: '18px',
							padding: '10px 12px',
							borderRadius: 8,
							border: `1px solid ${COLORS.border}`,
							background: COLORS.field,
							color: COLORS.text,
						},
					}),
				),
			);
		}

		/** 「编辑报警规则」弹窗层：`shell.overlay` 的**第二个**注册（与设置弹窗并列）。
		 *
		 *  只订阅 `useRulesDialogOpen()`：关着直接不渲染任何东西——宿主槽位永远挂着，
		 *  但不能在关着的时候留一层空遮罩挡住整页。
		 *  关闭**只置标志**，不调 `ctx.layout.selectPanel`：本弹窗不切主区域
		 *  （设置浮层那条路径才需要把主区域拉回会话）。 */
		function RulesDialogLayer() {
			const isOpen = useRulesDialogOpen();
			if (!isOpen) return null;
			return h(RulesDialog, { onRequestClose: () => setRulesDialogOpen(false) });
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				// **预加载配置**：插件一装上就把配置
				// 拉进模块级缓存，等用户点侧栏「报警提醒」时数据已经在内存里——弹窗瞬开，
				// 不会再先闪一帧「正在载入报警设置…」。失败不抛（缓存落 error，卡片打开时重试）。
				try {
					void refreshConfig();
				} catch {}
				// 每个槽位组件都过 guarded()：渲染期抛错只让这一块变空，绝不让整页白屏。
				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register(
						{
							name: 'sidebar.panellist',
							id: NS,
							order: 33,
							label: () => '报警提醒',
						},
						// 图标只置「要弹窗」的标志，弹窗本体由下面的 shell.overlay 层渲染。
						guarded('sidebar.panellist', (props) => h(AlarmPanelIcon, { ...props, ctx })),
					),
				);
				// 设置弹窗：宿主官方浮层槽位（**不再用 portal**）。
				ctx.slots.inject('shell.overlay', () =>
					ctx.slots.register(
						{
							name: 'shell.overlay',
							id: `${NS}.settings-dialog`,
							order: 120,
							label: () => '报警提醒设置',
						},
						guarded('shell.overlay', () => h(AlarmDialogLayer, { ctx })),
					),
				);
				// 「编辑报警规则」弹窗：**与上面并列的第二条 shell.overlay 注册**（不合并进设置弹窗）。
				// order 121 = 紧跟在设置弹窗（120）之后；两条各自订阅自己的标志，互不影响。
				// 同样过 guarded()：错误边界已被证明能防白屏（见文件头的说明）。
				ctx.slots.inject('shell.overlay', () =>
					ctx.slots.register(
						{
							name: 'shell.overlay',
							id: `${NS}.rules-dialog`,
							order: 121,
							label: () => '报警规则',
						},
						guarded('shell.overlay:rules', () => h(RulesDialogLayer, {})),
					),
				);
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: NS,
							order: 51,
							label: () => '报警提醒',
						},
						guarded('settings.section', () => h('div', { style: { padding: '4px 0' } }, h(AlarmSettingsCard, {}))),
					),
				);
				ctx.slots.inject('plugins.bundle.config', () =>
					ctx.slots.register(
						{
							name: 'plugins.bundle.config',
							key: NS,
						},
						guarded('plugins.bundle.config', () => h(AlarmSettingsCard, {})),
					),
				);
			},
		};
	},
});
