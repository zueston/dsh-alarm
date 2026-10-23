/** 离线自检：不启动 DSH，直接用假 ctx 跑 host/routes.js 的路由与 client.js 的 slot 注册。
 *
 *  覆盖面（改了产品代码就照着这份清单核对）：
 *   - **4 条路由**（全部 kind=exact）：`/api/dsh-alarm/config`、`/api/dsh-alarm/test`、
 *     `/api/dsh-alarm/agent-rules`、`/api/dsh-alarm/health`；
 *   - **5 处槽位注册**：`sidebar.panellist`(33)、`shell.overlay`×2（设置弹窗
 *     `dsh-alarm.settings-dialog` order 120 + 规则弹窗 `dsh-alarm.rules-dialog` order 121）、
 *     `settings.section`(51)、`plugins.bundle.config`；**绝不注册 `main`**（白屏根因，已删除）；
 *   - 设置字段总数 **63**；`GET agent-rules` 的规则块字符数 = `docs/agent-output-prompt.md`
 *     里第一个 ```text 围栏块的字符数。
 *
 *  **默认静默**：会真的响铃/弹窗的那段（POST /test）默认跳过，只有显式
 *  `DSH_ALARM_TEST_RING=1` 才跑——默认环境下本脚本不出声、不弹窗。
 *  用完即可删除（不是插件的一部分）。 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件根目录（本文件在 <root>/test/ 下，取上一级）。下游用它拼 host/、lib/、client.js 的路径。 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- 假 ctx / config ----------------
const writes = [];
const routes = [];

function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = String(body ?? '');
    },
  };
  return res;
}

function makeReq(method, body, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { host: '127.0.0.1:64804', ...headers };
  req.destroy = () => {};
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  return req;
}

const ctx = {
  logger: { info() {}, warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[err]', ...a) },
  settings: {
    async update(ns, values) {
      writes.push({ ns, values });
      Object.assign(config, values);
    },
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  effect(fn) {
    fn();
    return () => {};
  },
  get() {
    return undefined;
  },
};

const { Config } = await import(`file:///${SRC}/host/config.js`);
const config = Config({});

const { applyRoutes } = await import(`file:///${SRC}/host/routes.js`);
applyRoutes(ctx, config);

// ---------------- 路由表 ----------------
assert.strictEqual(routes.length, 4, `应注册 4 条路由，实际 ${routes.length}`);
const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
assert.ok(byPath['/api/dsh-alarm/config'], '缺 config 路由');
assert.ok(byPath['/api/dsh-alarm/test'], '缺 test 路由');
assert.ok(byPath['/api/dsh-alarm/agent-rules'], '缺 agent-rules 路由');
assert.ok(byPath['/api/dsh-alarm/health'], '缺 health 路由');
for (const route of routes) assert.strictEqual(route.kind, 'exact');
console.log('routes ok: %d 条 -> %s', routes.length, Object.keys(byPath).join(', '));

// ---------------- GET /config ----------------
let snapshot;
{
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(makeReq('GET'), res);
  assert.strictEqual(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.ok(payload.values && typeof payload.values === 'object', '缺 values');
  assert.deepStrictEqual(payload.expected, payload.values, 'expected 必须等于快照');
  assert.ok(Array.isArray(payload.options.wavs), 'wavs 必须是数组');
  assert.ok(payload.options.wavs.length > 20, `wavs 太少: ${payload.options.wavs.length}`);
  assert.ok(Array.isArray(payload.options.voices), 'voices 必须是数组');
  assert.strictEqual(Object.keys(payload.values).length, 63);
  assert.strictEqual(payload.values.sound, 'Alarm03.wav');
  assert.strictEqual(payload.values.popupStyle, 'topmost');
  // 默认只提醒「裁决 / 确认计划 / 任务完成 / 本轮报错」；「每轮结束」「本轮中断」默认关闭。
  assert.strictEqual(payload.values.alertAsk, true);
  assert.strictEqual(payload.values.alertPlan, true);
  assert.strictEqual(payload.values.alertTaskComplete, true);
  assert.strictEqual(payload.values.alertTurnEnd, false);
  assert.strictEqual(payload.values.alertTurnInterrupt, false);
  assert.strictEqual(payload.values.alertTurnError, true);
  // 设置页「测试提醒」也受开关控制（默认开）。
  assert.strictEqual(payload.values.alertTest, true);
  // 「任务到待人工测试」提醒默认开。
  assert.strictEqual(payload.values.alertAwaitingTest, true);
  // 「需要重启 DSH」提醒默认开。
  assert.strictEqual(payload.values.alertRestart, true);
  // 「待人工测试」的批次/聚合规则默认值（缺省 = 旧行为：每个任务各自提醒、不聚合）。
  assert.strictEqual(payload.values.awaitingTestScope, 'all');
  assert.strictEqual(payload.values.awaitingTestAnchor, '批次');
  assert.strictEqual(payload.values.awaitingTestQuietSeconds, 0);
  assert.strictEqual(payload.values.awaitingTestSummary, true);
  // 每条提醒的播报文本默认值。
  assert.strictEqual(payload.values.voiceTextAsk, '需要你裁决');
  assert.strictEqual(payload.values.voiceTextPlan, '需要你确认计划');
  assert.strictEqual(payload.values.voiceTextTaskComplete, '全部任务完成');
  assert.strictEqual(payload.values.voiceTextTurnEnd, '本轮结束');
  assert.strictEqual(payload.values.voiceTextInterrupt, '本轮中断');
  assert.strictEqual(payload.values.voiceTextError, '本轮报错');
  assert.strictEqual(payload.values.voiceTextAwaitingTest, '需要你手工测试');
  assert.strictEqual(payload.values.voiceTextRestart, '需要重启 DSH');
  assert.strictEqual(payload.values.voiceTextTest, '这是语音测试示例');
  assert.strictEqual(payload.values.voiceText, '{title}。{body}');
  // turnEndVoice / turnEndVoiceText 都已被「每条提醒自己的播报文本」取代，必须彻底消失。
  assert.strictEqual('turnEndVoice' in payload.values, false);
  assert.strictEqual('turnEndVoiceText' in payload.values, false);
  // 每条件三条通道（弹窗 / 警告音 / 语音播报）各 9 个开关；turnEndPopup 已被 popupTurnEnd 取代。
  assert.strictEqual('turnEndPopup' in payload.values, false);
  for (const kind of [
    'Ask',
    'Plan',
    'TaskComplete',
    'Restart',
    'AwaitingTest',
    'TurnEnd',
    'TurnInterrupt',
    'TurnError',
    'Test',
  ]) {
    assert.strictEqual(typeof payload.values[`popup${kind}`], 'boolean', `缺 popup${kind}`);
    assert.strictEqual(payload.values[`sound${kind}`], true, `sound${kind} 默认应为 true`);
    assert.strictEqual(payload.values[`voice${kind}`], true, `voice${kind} 默认应为 true`);
  }
  // 轻事件默认不弹窗；需要你动手的三件事 + 待人工测试 + 测试按钮默认弹窗。
  for (const kind of ['Ask', 'Plan', 'TaskComplete', 'AwaitingTest', 'Test']) {
    assert.strictEqual(payload.values[`popup${kind}`], true, `popup${kind} 默认应为 true`);
  }
  for (const kind of ['Restart', 'TurnEnd', 'TurnInterrupt', 'TurnError']) {
    assert.strictEqual(payload.values[`popup${kind}`], false, `popup${kind} 默认应为 false`);
  }
  // 三个通道总开关默认开启。
  assert.strictEqual(payload.values.enabled, true);
  assert.strictEqual(payload.values.popup, true);
  assert.strictEqual(payload.values.soundEnabled, true);
  assert.strictEqual(payload.values.voice, true);
  snapshot = payload.values;
  console.log(
    'GET config ok: wavs=%d (含 %s), voices=%j, values=%d 字段',
    payload.options.wavs.length,
    payload.options.wavs.includes('Alarm03.wav') ? 'Alarm03.wav' : '??',
    payload.options.voices,
    Object.keys(payload.values).length,
  );
}

// ---------------- POST /config：冲突 ----------------
{
  const res = makeRes();
  const body = {
    expected: { ...snapshot, soundRepeats: 5 },
    values: { ...snapshot },
  };
  await byPath['/api/dsh-alarm/config'].handler(makeReq('POST', body), res);
  assert.strictEqual(res.status, 409, `应 409，实际 ${res.status}: ${res.body}`);
  console.log('POST conflict ok: 409');
}

// ---------------- POST /config：成功 ----------------
{
  const next = { ...snapshot, soundRepeats: 3, popupStyle: 'modal', voice: true };
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(makeReq('POST', { expected: snapshot, values: next }), res);
  assert.strictEqual(res.status, 200, `应 200，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.ok(payload.values, '响应应带回快照');
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].ns, 'dsh-alarm', 'NS 必须是 loader 行 id');
  assert.strictEqual(writes[0].values.soundRepeats, 3);
  console.log('POST config ok: ns=%s soundRepeats=%d popupStyle=%s', writes[0].ns, writes[0].values.soundRepeats, writes[0].values.popupStyle);
}

// ---------------- POST /config：非法值 ----------------
{
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(
    makeReq('POST', { expected: snapshot, values: { ...snapshot, popupStyle: 'bogus' } }),
    res,
  );
  assert.strictEqual(res.status, 400, `应 400，实际 ${res.status}`);
  console.log('POST invalid ok: 400');
}

// ---------------- 非 loopback 拒绝 ----------------
{
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(makeReq('GET', undefined, { host: '192.168.1.9:64804' }), res);
  assert.strictEqual(res.status, 403);
  console.log('POST/GET non-loopback ok: 403');
}

// ---------------- GET /agent-rules：规则块 = docs 里第一个 ```text 围栏 ----------------
/** 从 markdown 里取出**第一个** ```text 围栏块的正文（本脚本独立实现，不复用 host 的私有函数，
 *  两处各自算一遍才有「对账」意义）。
 *
 *  **收尾围栏按 CommonMark 判：必须独占一行**（行首允许 ≤3 空格缩进，行内只留反引号）。
 *  不能拿「正文里出现的第一个三个反引号」当收尾——`docs/agent-output-prompt.md` 的 R1 那句里就有
 *  一个行内 ```...```（「围栏代码块（```...```）内的文字一律不算」），按字符位置截会只截到那一行。
 *  与 host/routes.js 同口径：只砍块首、块尾的空行，块内换行原样保留。 */
function firstTextBlock(markdown) {
  const lines = String(markdown).split('\n');
  const open = lines.findIndex((line) => line.trimStart().startsWith('```text'));
  assert.ok(open >= 0, '文档里找不到 ```text 围栏');
  let close = -1;
  for (let i = open + 1; i < lines.length; i += 1) {
    if (/^ {0,3}```+\s*$/u.test(lines[i])) {
      close = i;
      break;
    }
  }
  assert.ok(close > open, '文档里的 ```text 围栏没有闭合');
  const block = lines.slice(open + 1, close);
  while (block.length > 0 && block[0].trim() === '') block.shift();
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
  return block.join('\n');
}

{
  const res = makeRes();
  await byPath['/api/dsh-alarm/agent-rules'].handler(makeReq('GET'), res);
  assert.strictEqual(res.status, 200, `应 200，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.ok, true, 'agent-rules 的 ok 必须为 true');
  assert.strictEqual(typeof payload.text, 'string', 'agent-rules 的 text 必须是字符串');
  assert.ok(payload.text.length > 0, 'agent-rules 的 text 不能为空');
  assert.strictEqual(payload.missing, false, '规则文件必须读得到（missing=false）');
  const expected = firstTextBlock(readFileSync(`${SRC}/docs/agent-output-prompt.md`, 'utf8'));
  assert.strictEqual(
    payload.text.length,
    expected.length,
    `规则块字符数须与文档第一个 text 围栏一致：文档 ${expected.length}，路由 ${payload.text.length}`,
  );
  // 字符数相同还不够（等长不同文也算过）：正文必须逐字相同，前端才能「一键复制」。
  assert.strictEqual(payload.text, expected, '规则块正文须与文档第一个 text 围栏逐字一致');
  // 围栏截断的反证：R1 那句里的行内 ``` 之后还有 R2~R11，被按字符位置截就会全丢。
  assert.ok(payload.text.startsWith('【报警提醒输出约束】'), '规则块应从「【报警提醒输出约束】」开始');
  assert.ok(payload.text.includes('R11 交付口径'), '规则块被行内 ``` 截断了（少了 R11 及其后内容）');
  console.log(
    'GET agent-rules ok: %d 字符（= docs 第一个 text 围栏）、missing=false、含 R11',
    payload.text.length,
  );
}

// ---------------- POST /test：默认跳过（这一段会真的响铃/弹窗） ----------------
if (process.env.DSH_ALARM_TEST_RING === '1') {
  // 关闭总开关时 delivered 应为 false 且不 spawn —— 依然走真实路由，只是不出声。
  config.enabled = false;
  const res = makeRes();
  await byPath['/api/dsh-alarm/test'].handler(makeReq('POST', {}), res);
  assert.strictEqual(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.strictEqual(typeof payload.delivered, 'boolean', 'test 路由应返回 delivered 布尔值');
  assert.ok(payload.settings && payload.settings.popupStyle, 'test 路由应带回生效设置');
  console.log('POST test ok: delivered=%s popupStyle=%s（若 delivered=true 会真的响铃+弹窗）', payload.delivered, payload.settings.popupStyle);
} else {
  console.log('SKIP: 真实响铃用例（设 DSH_ALARM_TEST_RING=1 才跑）');
}

// ---------------- client.js：模拟 __ModuleLoader__（假 React 只喂注册期用得到的 API） ----------------
{
  const registered = [];
  const fakeSlots = {
    inject(name, register) {
      assert.strictEqual(typeof register, 'function');
      register();
    },
    register(spec, component) {
      registered.push({ spec, component });
      return () => {};
    },
  };
  let factory = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        factory = entry.factory;
      },
    },
  };
  /** `React.memo` 被调了几次：client.js 的三行组件（列名行/条件行/字段行）全靠它跳过无变化的重渲染，
   *  假 React 少给 `memo` 会直接 `TypeError: React.memo is not a function`（本脚本曾经就这样炸过）。 */
  let memoCalls = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    // Hook 只喂「顶层不炸」的盒式实现：本脚本断言的是注册表，不是渲染结果。
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init ?? null }),
    useMemo: (fn) => fn(),
    // `React.memo(渲染体, 比较器)`：返回带 `compare` 的包装函数即可（只登记不渲染）。
    memo: (fn, compare) => {
      memoCalls += 1;
      const wrapped = (props) => fn(props);
      wrapped.compare = compare;
      return wrapped;
    },
    // `class AlarmBoundary extends React.Component`（错误边界）：super(props) 要能跑、state 要能挂。
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
  };
  const source = readFileSync(`${SRC}/client.js`, 'utf8');
  // 客户端 bundle 在浏览器里是 <script> 直接执行，这里用同样的方式跑。
  new Function('window', 'fetch', 'Headers', source)(globalThis.window, () => {}, class Headers {});
  assert.ok(factory, 'client.js 没有调用 __ModuleLoader__.load');
  const mod = factory((id) => {
    assert.strictEqual(id, 'react');
    return React;
  });
  assert.deepStrictEqual(mod.inject, ['slots']);
  mod.apply({ slots: fakeSlots });
  assert.ok(memoCalls >= 3, `client.js 应至少调用 3 次 React.memo（列名行/条件行/字段行），实际 ${memoCalls}`);
  assert.strictEqual(registered.length, 5, `应注册 5 处槽位，实际 ${registered.length}`);
  const names = registered.map((r) => r.spec.name);
  // 顺序即 client.js 里的注册顺序：两个弹窗都挂在 shell.overlay，各自订阅自己的标志。
  assert.deepStrictEqual(names, [
    'sidebar.panellist',
    'shell.overlay',
    'shell.overlay',
    'settings.section',
    'plugins.bundle.config',
  ]);
  // **绝不注册 main**：`main` 槽位会把主区域整块换掉（白屏根因），弹窗改走 shell.overlay。
  assert.strictEqual(names.includes('main'), false, '绝不能注册 main 槽位（白屏根因）');
  const sidebar = registered[0].spec;
  assert.strictEqual(sidebar.id, 'dsh-alarm');
  assert.strictEqual(sidebar.order, 33);
  assert.strictEqual(sidebar.label(), '报警提醒');
  const settingsDialog = registered[1].spec;
  assert.strictEqual(settingsDialog.id, 'dsh-alarm.settings-dialog');
  assert.strictEqual(settingsDialog.order, 120);
  const rulesDialog = registered[2].spec;
  assert.strictEqual(rulesDialog.id, 'dsh-alarm.rules-dialog');
  assert.strictEqual(rulesDialog.order, 121);
  assert.strictEqual(registered[3].spec.id, 'dsh-alarm', 'settings.section.id 必须是 NS');
  assert.strictEqual(registered[3].spec.order, 51);
  assert.strictEqual(registered[4].spec.key, 'dsh-alarm', 'plugins.bundle.config.key 必须与 NS 一致');
  for (const entry of registered) assert.strictEqual(typeof entry.component, 'function');
  console.log('client slots ok: %d 处 | %s | sidebar order = %d', registered.length, names.join(', '), sidebar.order);
}

console.log('\nALL CHECKS PASSED');
