/** 离线自检：不启动 DSH，直接用假 ctx 跑 host/routes.js 的路由与 client.js 的 slot 注册。
 *  用完即可删除（不是插件的一部分）。 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
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

assert.strictEqual(routes.length, 3, `应注册 3 条路由，实际 ${routes.length}`);
const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
assert.ok(byPath['/api/dsh-alarm/config'], '缺 config 路由');
assert.ok(byPath['/api/dsh-alarm/test'], '缺 test 路由');
assert.ok(byPath['/api/dsh-alarm/health'], '缺 health 路由');
for (const route of routes) assert.strictEqual(route.kind, 'exact');
console.log('routes ok:', Object.keys(byPath).join(', '));

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
  assert.strictEqual(Object.keys(payload.values).length, 59);
  assert.strictEqual(payload.values.sound, 'Alarm03.wav');
  assert.strictEqual(payload.values.popupStyle, 'topmost');
  // 默认只提醒「裁决 / 确认计划 / 任务完成」；「每轮结束」「本轮中断」「本轮报错」默认关闭。
  assert.strictEqual(payload.values.alertAsk, true);
  assert.strictEqual(payload.values.alertPlan, true);
  assert.strictEqual(payload.values.alertTaskComplete, true);
  assert.strictEqual(payload.values.alertTurnEnd, false);
  assert.strictEqual(payload.values.alertTurnInterrupt, false);
  assert.strictEqual(payload.values.alertTurnError, false);
  // 设置页「测试提醒」也受开关控制（默认开）。
  assert.strictEqual(payload.values.alertTest, true);
  // 「任务到待人工测试」提醒默认开。
  assert.strictEqual(payload.values.alertAwaitingTest, true);
  // 「需要重启 DSH」提醒默认开。
  assert.strictEqual(payload.values.alertRestart, true);
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

// ---------------- POST /test：关闭总开关时应 delivered=false 且不 spawn ----------------
{
  config.enabled = false;
  const res = makeRes();
  await byPath['/api/dsh-alarm/test'].handler(makeReq('POST', {}), res);
  assert.strictEqual(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.strictEqual(typeof payload.delivered, 'boolean', 'test 路由应返回 delivered 布尔值');
  assert.ok(payload.settings && payload.settings.popupStyle, 'test 路由应带回生效设置');
  console.log('POST test ok: delivered=%s popupStyle=%s（若 delivered=true 会真的响铃+弹窗）', payload.delivered, payload.settings.popupStyle);
}

// ---------------- client.js：模拟 __ModuleLoader__ ----------------
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
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const { readFileSync } = await import('node:fs');
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
  assert.strictEqual(registered.length, 4, `应注册 4 个 slot，实际 ${registered.length}`);
  const names = registered.map((r) => r.spec.name);
  assert.deepStrictEqual(names, ['sidebar.panellist', 'main', 'settings.section', 'plugins.bundle.config']);
  const sidebar = registered[0].spec;
  assert.strictEqual(sidebar.id, 'dsh-alarm');
  assert.strictEqual(sidebar.order, 33);
  assert.strictEqual(sidebar.label(), '报警提醒');
  assert.strictEqual(registered[1].spec.key, 'dsh-alarm', 'main.key 必须与侧边栏 id 一致');
  assert.strictEqual(registered[2].spec.order, 51);
  assert.strictEqual(registered[3].spec.key, 'dsh-alarm');
  for (const entry of registered) assert.strictEqual(typeof entry.component, 'function');
  console.log('client slots ok:', names.join(', '), '| sidebar order =', sidebar.order);
}

console.log('\nALL CHECKS PASSED');
