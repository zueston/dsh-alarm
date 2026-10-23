/** 离线自检：不启动 DSH，直接用假 ctx 跑 host/routes.js 的路由与 client.js 的 slot 注册。
 *
 *  覆盖面（改了产品代码就照着这份清单核对）：
 *   - **5 条路由**（全部 kind=exact）：`/api/dsh-alarm/config`、`/api/dsh-alarm/test`、
 *     `/api/dsh-alarm/agent-rules`、`/api/dsh-alarm/sound`、`/api/dsh-alarm/health`；
 *   - **5 处槽位注册**：`sidebar.panellist`(33)、`shell.overlay`×2（设置弹窗
 *     `dsh-alarm.settings-dialog` order 120 + 规则弹窗 `dsh-alarm.rules-dialog` order 121）、
 *     `settings.section`(51)、`plugins.bundle.config`；**绝不注册 `main`**（白屏根因，已删除）；
 *   - 设置字段总数 **72**；`GET config` 的 `defaults` 键集合与 `values` 完全相同（「恢复默认」用），
 *     且协议模式是**两态**：`defaults.protocolMode === 'tag-first'`，旧布尔 `protocolMode: true/false`
 *     与已删除的第三态 `'heuristic-only'` 提交时一律归一化为 `tag-first`、`'tag-only'` 原样保留；
 *   - **`POST config` 的三个注册范围（`showInMain`/`showInPlugins`/`showInSettings`）不许同时为 false**：
 *     全关 → 400 `code:"last-slot"` 且不落盘，只关掉其中一个 → 200；
 *     `GET agent-rules` 的规则块字符数 = `docs/agent-output-prompt.md`
 *     里第一个 ```text 围栏块的字符数；
 *   - `lib/alarm.js` 的 `parseAlarmTags`（严格输出协议）：6 个标签各一条 + 行内出现不匹配
 *     + 大小写错误不匹配 + TEST 空任务名；
 *   - `POST /sound`（上传自定义铃声）：合法 wav → 200 且**文件真的落盘**（写进临时 `DSH_HOME`，
 *     跑完清理）、非法扩展名 → 400、解码后超 2 MB → 400、非 POST → 405。
 *
 *  **DSH_HOME 指向临时目录**：上传路由会真的写文件，不能写进用户的 `~/.dsh`
 *  （`materializeScript` 的预热脚本也跟着落进去，同样无害）。
 *
 *  **默认静默**：会真的响铃/弹窗的那段（POST /test）默认跳过，只有显式
 *  `DSH_ALARM_TEST_RING=1` 才跑——默认环境下本脚本不出声、不弹窗。
 *  用完即可删除（不是插件的一部分）。 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件根目录（本文件在 <root>/test/ 下，取上一级）。下游用它拼 host/、lib/、client.js 的路径。 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- 临时 DSH_HOME（上传铃声会真的写文件） ----------------
// 必须在 import 宿主代码**之前**设好：lib/alarm.js 的 dshHome() 是**调用时**现读 env，
// 但 applyRoutes() 会立刻预热脚本、上传用例也会立刻落盘，早点设省得写进用户的 ~/.dsh。
const HOME = mkdtempSync(resolve(tmpdir(), 'dsh-alarm-verify-'));
process.env.DSH_HOME = HOME;

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
assert.strictEqual(routes.length, 5, `应注册 5 条路由，实际 ${routes.length}`);
const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
assert.ok(byPath['/api/dsh-alarm/config'], '缺 config 路由');
assert.ok(byPath['/api/dsh-alarm/test'], '缺 test 路由');
assert.ok(byPath['/api/dsh-alarm/agent-rules'], '缺 agent-rules 路由');
assert.ok(byPath['/api/dsh-alarm/sound'], '缺 sound（自定义铃声上传）路由');
assert.ok(byPath['/api/dsh-alarm/health'], '缺 health 路由');
for (const route of routes) assert.strictEqual(route.kind, 'exact');
console.log('routes ok: %d 条 -> %s', routes.length, Object.keys(byPath).join(', '));

/** GET 一次 /config（返回 { values, expected, defaults, options }）：后面的 POST 用例要拿
 *  **当前**快照当 `expected`，否则乐观并发会 409 而不是测到想测的那条分支。 */
async function getConfig() {
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(makeReq('GET'), res);
  assert.strictEqual(res.status, 200, `GET 应 200，实际 ${res.status}`);
  return JSON.parse(res.body);
}

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
  assert.strictEqual(Object.keys(payload.values).length, 72);
  assert.strictEqual(payload.values.sound, 'Alarm03.wav');
  assert.strictEqual(payload.values.popupStyle, 'topmost');
  // 卡片注册范围（标题行三个勾选框）：默认只有「主窗口」，插件页 / 设置页默认关。
  assert.strictEqual(payload.values.showInMain, true, 'showInMain 默认应为 true');
  assert.strictEqual(payload.values.showInPlugins, false, 'showInPlugins 默认应为 false');
  assert.strictEqual(payload.values.showInSettings, false, 'showInSettings 默认应为 false');
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
  // 严格输出协议是两态枚举，默认 `tag-first`（默认模式：标签优先 + 旧判定兜底）。
  assert.strictEqual(payload.values.protocolMode, 'tag-first');
  // 「Agent 停下来且没有后续动作」默认开；弹窗也默认开（停住 = 必须有人接手，
  // 只响一声铃声容易被忽略；这是唯一一个默认弹窗的「轻事件」例外）。
  assert.strictEqual(payload.values.alertStalled, true);
  assert.strictEqual(payload.values.soundStalled, true);
  assert.strictEqual(payload.values.voiceStalled, true);
  assert.strictEqual(payload.values.popupStalled, true, 'popupStalled 默认应为 true');
  assert.strictEqual(payload.values.voiceTextStalled, '我停下来了，没有后续动作');
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
    'Stalled',
    'Test',
  ]) {
    assert.strictEqual(typeof payload.values[`popup${kind}`], 'boolean', `缺 popup${kind}`);
    assert.strictEqual(payload.values[`sound${kind}`], true, `sound${kind} 默认应为 true`);
    assert.strictEqual(payload.values[`voice${kind}`], true, `voice${kind} 默认应为 true`);
  }
  // 轻事件默认不弹窗；需要你动手的三件事 + 待人工测试 + 测试按钮默认弹窗；
  // 「停住」是例外（默认弹窗：没人接手就不会再有进展）。
  for (const kind of ['Ask', 'Plan', 'TaskComplete', 'AwaitingTest', 'Test', 'Stalled']) {
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
  // ---- 恢复默认用的 `defaults`（GET /config 追加的字段）-------------------
  // 键集合必须与 values **完全相同**：前端拿它整体替换页面 values，缺一个键就会 400。
  assert.ok(payload.defaults && typeof payload.defaults === 'object', '缺 defaults');
  assert.deepStrictEqual(
    Object.keys(payload.defaults).sort(),
    Object.keys(payload.values).sort(),
    'defaults 的键集合必须与 values 完全相同',
  );
  assert.strictEqual(Object.keys(payload.defaults).length, 72, 'defaults 也必须恰好 72 个键');
  // 三个「注册范围」字段必须同时出现在 values 与 defaults 里：前端拿 defaults 整体替换页面
  // values，缺任何一个键都会让宿主 `coerceValues()` 整体返回 null → 400。
  for (const key of ['showInMain', 'showInPlugins', 'showInSettings']) {
    assert.strictEqual(key in payload.values, true, `values 缺 ${key}`);
    assert.strictEqual(key in payload.defaults, true, `defaults 缺 ${key}`);
  }
  assert.strictEqual(payload.defaults.showInMain, true, 'defaults.showInMain 必须是 true');
  assert.strictEqual(payload.defaults.showInPlugins, false, 'defaults.showInPlugins 必须是 false');
  assert.strictEqual(payload.defaults.showInSettings, false, 'defaults.showInSettings 必须是 false');
  assert.strictEqual(payload.defaults.protocolMode, 'tag-first', 'defaults.protocolMode 必须是 tag-first');
  assert.strictEqual(payload.defaults.alertStalled, true, 'defaults.alertStalled 必须是 true');
  // 「恢复默认」也要还原成新默认值（弹窗开）：三处默认值（schema / FIELDS / DEFAULTS）必须同口径，
  // 只改两处时这里会红。
  assert.strictEqual(payload.defaults.popupStalled, true, 'defaults.popupStalled 必须是 true');
  assert.strictEqual(payload.defaults.popupStyle, 'topmost', 'defaults.popupStyle 必须是 topmost');
  assert.strictEqual(payload.defaults.awaitingTestScope, 'all', 'defaults.awaitingTestScope 必须是 all');
  snapshot = payload.values;
  console.log(
    'GET config ok: wavs=%d (含 %s), voices=%j, values=%d 字段, defaults=%d 字段',
    payload.options.wavs.length,
    payload.options.wavs.includes('Alarm03.wav') ? 'Alarm03.wav' : '??',
    payload.options.voices,
    Object.keys(payload.values).length,
    Object.keys(payload.defaults).length,
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

// ---------------- POST /config：三个注册范围全 false → 400 code:"last-slot" ----------------
// 用户口径：三个入口（主窗口 / 插件页 / 设置页）**不许同时关掉**——全关 = 这张设置卡片再无
// 任何入口，只能去手改配置才能救回来。校验是**服务端的唯一兜底**（前端那层「最后一个勾选
// 置灰」已按用户要求去掉，改成「后端拒绝 + 页面回滚 + 提示」）。
{
  const current = await getConfig();
  const writesBefore = writes.length;
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(
    makeReq('POST', {
      expected: current.values,
      values: { ...current.values, showInMain: false, showInPlugins: false, showInSettings: false },
    }),
    res,
  );
  assert.strictEqual(res.status, 400, `三个全关应 400，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.code, 'last-slot', 'code 必须是 last-slot（前端据此回滚）');
  assert.strictEqual(
    payload.error,
    '至少要保留一个入口（主窗口 / 插件页 / 设置页），否则你将再也打不开这个设置页',
    'error 文案必须逐字一致（前端另一句提示走的是自己那份常量）',
  );
  assert.strictEqual(writes.length, writesBefore, '被拒绝的提交绝不能落盘');
  console.log('POST 三个注册范围全关 ok: 400 code=%s 且未落盘', payload.code);
}

// 紧接着一个**合法**组合（只留插件页）必须 200：拒绝的是「全关」，不是「关掉某一个」。
{
  const current = await getConfig();
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(
    makeReq('POST', {
      expected: current.values,
      values: { ...current.values, showInMain: false, showInPlugins: true, showInSettings: false },
    }),
    res,
  );
  assert.strictEqual(res.status, 200, `只留插件页应 200，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.values.showInMain, false);
  assert.strictEqual(payload.values.showInPlugins, true);
  assert.strictEqual(payload.values.showInSettings, false);
  assert.strictEqual(writes.at(-1).values.showInPlugins, true, '写入磁盘的值必须就是这次提交的值');
  console.log('POST 只留插件页 ok: 200 showInMain=false showInPlugins=true');
}

// ---------------- POST /config：协议模式 = 两态 + 历史值全归一化到 tag-first ----------------
// 这次事故的回归护栏：磁盘上的旧值（1.3.x 的布尔 true/false、1.4.x 的第三态 heuristic-only）
// 提交上来**不能 400**，一律静默改写成 tag-first；只有 'tag-only' 是「另一个合法值」。
{
  const current = await getConfig();
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(
    makeReq('POST', { expected: current.values, values: { ...current.values, protocolMode: true } }),
    res,
  );
  assert.strictEqual(res.status, 200, `应 200，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.values.protocolMode, 'tag-first', '旧的 true 必须归一化为 tag-first');
  assert.strictEqual(writes.at(-1).values.protocolMode, 'tag-first', '写入磁盘的值必须是 tag-first');
  console.log('POST protocolMode=true ok: true → tag-first');
}
{
  const current = await getConfig();
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(
    makeReq('POST', { expected: current.values, values: { ...current.values, protocolMode: false } }),
    res,
  );
  assert.strictEqual(res.status, 200, `应 200，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.values.protocolMode, 'tag-first', '旧的 false 必须归一化为 tag-first');
  assert.strictEqual(writes.at(-1).values.protocolMode, 'tag-first', '写入磁盘的值必须是 tag-first');
  console.log('POST protocolMode=false ok: false → tag-first');
}
{
  const current = await getConfig();
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(
    makeReq('POST', { expected: current.values, values: { ...current.values, protocolMode: 'heuristic-only' } }),
    res,
  );
  assert.strictEqual(res.status, 200, `应 200，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.values.protocolMode, 'tag-first', '已删除的 heuristic-only 必须归一化为 tag-first');
  assert.strictEqual(writes.at(-1).values.protocolMode, 'tag-first', '写入磁盘的值必须是 tag-first');
  // defaults 与当前配置**无关**：此刻磁盘上是归一化后的值，defaults 仍是 tag-first。
  assert.strictEqual(payload.defaults.protocolMode, 'tag-first', 'defaults 必须与当前配置无关');
  console.log('POST protocolMode=heuristic-only ok: heuristic-only → tag-first（defaults 仍为 tag-first）');
}
{
  const current = await getConfig();
  const res = makeRes();
  await byPath['/api/dsh-alarm/config'].handler(
    makeReq('POST', { expected: current.values, values: { ...current.values, protocolMode: 'tag-only' } }),
    res,
  );
  assert.strictEqual(res.status, 200, `应 200，实际 ${res.status}: ${res.body}`);
  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.values.protocolMode, 'tag-only', "要存的 'tag-only' 必须原样保留");
  assert.strictEqual(writes.at(-1).values.protocolMode, 'tag-only', "写入磁盘的值必须是 'tag-only'");
  console.log("POST protocolMode=tag-only ok: 'tag-only' 原样保留");
}

// ---------------- POST /sound：上传自定义铃声（唯一会写文件的路由） ----------------
/** 拼一个**最小但合法**的 WAV：44 字节头 + payloadBytes 个静音采样。 */
function makeWav(payloadBytes = 8) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + payloadBytes, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(8000, 24); // 采样率
  header.writeUInt32LE(8000, 28); // 每秒字节数
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // 位深
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(payloadBytes, 40);
  return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
}

/** 发一次上传请求（走真实路由 + 真实 guard：Host 头是 loopback）。 */
async function postSound(body, method = 'POST') {
  const res = makeRes();
  await byPath['/api/dsh-alarm/sound'].handler(makeReq(method, body), res);
  return { status: res.status, payload: res.body === '' ? null : JSON.parse(res.body) };
}

// 1) 合法 wav → 200，且**文件真的落盘**（字节逐个相等）。
{
  const wav = makeWav(64);
  const { status, payload } = await postSound({ fileName: 'my-alarm.wav', dataBase64: wav.toString('base64') });
  assert.strictEqual(status, 200, `应 200，实际 ${status}: ${JSON.stringify(payload)}`);
  assert.strictEqual(payload.ok, true, 'ok 必须是 true');
  assert.strictEqual(payload.bytes, wav.length, `bytes 应为解码后长度 ${wav.length}，实际 ${payload.bytes}`);
  assert.ok(
    resolve(payload.path).startsWith(resolve(HOME)),
    `落盘路径必须在临时 DSH_HOME 下：${payload.path}`,
  );
  assert.strictEqual(
    resolve(dirname(payload.path)),
    resolve(HOME, 'alarm', 'sounds'),
    '必须落在 <DSH_HOME>/alarm/sounds 下',
  );
  assert.ok(payload.path.endsWith('dsh-alarm-my-alarm.wav'), `文件名应带 dsh-alarm- 前缀：${payload.path}`);
  assert.strictEqual(existsSync(payload.path), true, '响应说成功，文件就必须真的存在');
  assert.deepStrictEqual(readFileSync(payload.path), wav, '落盘字节必须与上传字节逐字节一致');
  console.log('POST sound ok: %s（%d 字节，已落盘且逐字节一致）', payload.path, payload.bytes);
}

// 2) 文件名清洗：`..\evil name.wav` → 只留 [A-Za-z0-9._-]，其余变 `_`，且**不越出 sounds 目录**。
{
  const wav = makeWav(8);
  const { status, payload } = await postSound({ fileName: '..\\evil name.wav', dataBase64: wav.toString('base64') });
  assert.strictEqual(status, 200, `应 200，实际 ${status}: ${JSON.stringify(payload)}`);
  assert.strictEqual(
    resolve(dirname(payload.path)),
    resolve(HOME, 'alarm', 'sounds'),
    `清洗后仍是 sounds 目录下的单个文件（无目录穿越）：${payload.path}`,
  );
  assert.strictEqual(
    basename(payload.path),
    'dsh-alarm-.._evil_name.wav',
    `清洗结果不符：${payload.path}`,
  );
  console.log('POST sound 文件名清洗 ok: %s', basename(payload.path));
}

// 3) 非法扩展名 → 400（不区分大小写的 .wav 才认）。
{
  const wav = makeWav(8);
  const { status, payload } = await postSound({ fileName: 'evil.mp3', dataBase64: wav.toString('base64') });
  assert.strictEqual(status, 400, `非法扩展名应 400，实际 ${status}: ${JSON.stringify(payload)}`);
  assert.match(payload.error, /\.wav/u, `400 的 error 要说明原因，实际 ${JSON.stringify(payload)}`);
  console.log('POST sound 非法扩展名 ok: 400 %j', payload.error);
}

// 4) 解码后超 2 MB → 400（按**解码后的字节数**判，不是按 base64 长度）。
{
  const wav = makeWav(2 * 1024 * 1024); // 44 字节头 + 2 MB 数据 → 超限
  const { status, payload } = await postSound({ fileName: 'big.wav', dataBase64: wav.toString('base64') });
  assert.strictEqual(status, 400, `超 2 MB 应 400，实际 ${status}: ${JSON.stringify(payload)}`);
  assert.match(payload.error, /too large|2\d{2,}/u, `error 要说明原因，实际 ${JSON.stringify(payload)}`);
  console.log('POST sound 超 2MB ok: 400 %j', payload.error);
}

// 5) 前 4 字节不是 RIFF（魔数不对）→ 400；写盘面为零。
{
  const { status, payload } = await postSound({
    fileName: 'fake.wav',
    dataBase64: Buffer.from('NOTARIFF-not-a-wav').toString('base64'),
  });
  assert.strictEqual(status, 400, `非 RIFF 应 400，实际 ${status}: ${JSON.stringify(payload)}`);
  assert.match(payload.error, /RIFF/u, `error 要说明原因，实际 ${JSON.stringify(payload)}`);
  assert.strictEqual(existsSync(resolve(HOME, 'alarm', 'sounds', 'dsh-alarm-fake.wav')), false, '被拒绝的请求不能落盘');
  console.log('POST sound 非 RIFF ok: 400 %j（未落盘）', payload.error);
}

// 6) 只接受 POST（与其它路由同一道方法围栏）。
{
  const { status } = await postSound(undefined, 'GET');
  assert.strictEqual(status, 405, `GET 应 405，实际 ${status}`);
  console.log('POST sound 方法围栏 ok: GET → 405');
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
  // 围栏截断的反证：R0 那句里的行内 ``` 之后还有 R1~R5，被按字符位置截就会全丢。
  assert.ok(payload.text.startsWith('【报警提醒输出协议】'), '规则块应从「【报警提醒输出协议】」开始');
  assert.ok(payload.text.includes('R5 收尾自检'), '规则块被行内 ``` 截断了（少了 R5 及其后内容）');
  console.log(
    'GET agent-rules ok: %d 字符（= docs 第一个 text 围栏）、missing=false、含 R5',
    payload.text.length,
  );
}

// ---------------- lib/alarm.js：parseAlarmTags（严格输出协议） ----------------
{
  const { parseAlarmTags } = await import(`file:///${SRC}/lib/alarm.js`);
  /** 只有「独占一行 + 大写 kind + 双中括号」才算；每轮可以有多条标签。 */
  const cases = [
    { id: 'ask', text: '好的，我停在这里。\n[[ALARM:ASK]]', expect: [{ kind: 'ASK', taskName: '' }] },
    { id: 'plan', text: '[[ALARM:PLAN]]', expect: [{ kind: 'PLAN', taskName: '' }] },
    { id: 'done', text: '跑完了。\n\n  [[ALARM:DONE]]  \n', expect: [{ kind: 'DONE', taskName: '' }] },
    { id: 'restart', text: '改完了。\n[[ALARM:RESTART]]\n', expect: [{ kind: 'RESTART', taskName: '' }] },
    { id: 'stalled', text: '[[ALARM:STALLED]]', expect: [{ kind: 'STALLED', taskName: '' }] },
    {
      id: 'test-with-name',
      text: 'TP-7 到了。\n[[ALARM:TEST:TP-7-批量测试协调]]',
      expect: [{ kind: 'TEST', taskName: 'TP-7-批量测试协调' }],
    },
    // TEST 的任务名可为空串（`[[ALARM:TEST:]]` / `[[ALARM:TEST]]` 都算）。
    { id: 'test-empty-name', text: '[[ALARM:TEST:  ]]', expect: [{ kind: 'TEST', taskName: '' }] },
    { id: 'test-bare', text: '[[ALARM:TEST]]', expect: [{ kind: 'TEST', taskName: '' }] },
    // 行内出现不算（必须独占一行）。
    {
      id: 'inline-no-match',
      text: '我只认 [[ALARM:RESTART]] 这个标签，但它写在句子中间。',
      expect: [],
    },
    // 大小写错误不算（区分大小写）。
    { id: 'lowercase-no-match', text: '[[alarm:restart]]', expect: [] },
    { id: 'mixedcase-no-match', text: '[[Alarm:Test:TP-1]]', expect: [] },
    // 一轮里多条 → 按出现顺序全部返回。
    {
      id: 'multi',
      text: '[[ALARM:DONE]]\n[[ALARM:TEST:TP-1]]\n[[ALARM:STALLED]]',
      expect: [
        { kind: 'DONE', taskName: '' },
        { kind: 'TEST', taskName: 'TP-1' },
        { kind: 'STALLED', taskName: '' },
      ],
    },
    // 纯函数、不抛：非字符串入参一律空数组。
    { id: 'non-string', text: undefined, expect: [] },
  ];
  for (const item of cases) {
    const got = parseAlarmTags(item.text);
    assert.deepStrictEqual(got, item.expect, `parseAlarmTags 用例 ${item.id} 不符：${JSON.stringify(got)}`);
  }
  console.log('parseAlarmTags ok: %d 组用例（6 个标签 + 行内/大小写/空任务名/多条/非字符串）', cases.length);
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
  // 条件表行数 = 10（每行一个 `alert: 'alertXxx',`）。新增/删除条件行时这里必须同步；
  // 新条件（Agent 停下来且没有后续动作）必须排在「本轮报错」之后、「手工测试」之前。
  const conditionRows = (source.match(/^\t+alert: 'alert[A-Za-z]+',$/gmu) ?? []).length;
  assert.strictEqual(conditionRows, 10, `条件表应有 10 行，实际 ${conditionRows}`);
  const stalledRowAt = source.indexOf("alert: 'alertStalled',");
  assert.ok(stalledRowAt > 0, 'client.js 缺「Agent 停下来且没有后续动作」条件行');
  assert.ok(
    source.indexOf("alert: 'alertTurnError',") < stalledRowAt && stalledRowAt < source.indexOf("alert: 'alertTest',"),
    '新条件行应排在「本轮报错」之后、「手工测试」之前',
  );
  // 客户端 bundle 在浏览器里是 <script> 直接执行，这里用同样的方式跑。
  new Function('window', 'fetch', 'Headers', source)(globalThis.window, () => {}, class Headers {});
  assert.ok(factory, 'client.js 没有调用 __ModuleLoader__.load');
  const mod = factory((id) => {
    assert.strictEqual(id, 'react');
    return React;
  });
  assert.deepStrictEqual(mod.inject, ['slots']);
  // 客户端键表（`missingFieldKeys({})` = 整张表）必须与宿主 `FIELDS` 的键表**逐键一致**：
  // 少一个键，页面快照旧了也不会自愈，保存时宿主 `coerceValues()` 直接 400。
  // 标题行的三个 `showIn*` 字段不渲染在任何分区里，最容易漏在这张表外面。
  const clientKeys = mod.missingFieldKeys({}).sort();
  assert.strictEqual(clientKeys.length, 72, `client 键表应有 72 个键，实际 ${clientKeys.length}`);
  assert.deepStrictEqual(clientKeys, Object.keys(snapshot).sort(), 'client 键表必须与宿主 FIELDS 完全一致');
  console.log('client 键表 ok: %d 键，与宿主 FIELDS 逐键一致', clientKeys.length);
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

// ---------------- client.js：设置卡片的渲染结构（视觉重做的结构性回归） ----------------
// 上面那段只验「注册表」，验不到渲染出来的东西。这里把 client.js **再装一次**（模块级状态全新），
// 配一套极小的 React 替身把设置卡片真渲染成宿主树，再按结构断言：
//   - 条件表 10 行；表头**两行**（第一行四个通道总开关，第二行六个文字标签）；
//   - 每行恰好 4 个开关 + 1 个播报文本输入；
//   - 协议模式是分段控件（2 个选项，值仍是 tag-first / tag-only）；
//   - 「严格模式」后面是 15×15 的 `?` 徽标，点开是**自绘说明卡片**（正文逐字等于 `STRICT_MODE_TIP`）：
//     徽标 `role="button"` + `aria-label="严格模式说明"` + 无 `title` 属性；未开合时整棵树没有
//     `role="tooltip"` 节点，开合后恰好 1 个；旧气泡那套 `tip-bubble` 类全树、全文都没有残留；
//   - **TTS 分区里不再有逐条件播报文本字段**（那 10 个 `voiceText*` 已经上移到条件表最后一列）。
{
  /** 组件渲染帧：hooks 按调用顺序编号（迷你版，够单次静态渲染用）。 */
  let frame = null;
  const MiniReact = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else flat.push(child);
      }
      const nextProps = { ...(props ?? {}) };
      nextProps.children = flat.length > 1 ? flat : flat[0];
      return { type, props: nextProps, children: flat };
    },
    memo: (fn) => fn,
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
      static getDerivedStateFromError() {
        return { failed: false };
      }
    },
    useState(init) {
      const index = frame.index++;
      if (!(index in frame.hooks)) frame.hooks[index] = typeof init === 'function' ? init() : init;
      const set = (next) => {
        frame.hooks[index] = typeof next === 'function' ? next(frame.hooks[index]) : next;
      };
      return [frame.hooks[index], set];
    },
    useEffect(fn) {
      frame.index += 1;
      frame.effects.push(fn);
    },
    useLayoutEffect(fn) {
      frame.index += 1;
      frame.effects.push(fn);
    },
    useCallback(fn) {
      frame.index += 1;
      return fn;
    },
    useMemo(fn) {
      frame.index += 1;
      return fn();
    },
    useRef(init) {
      const index = frame.index++;
      if (!(index in frame.hooks)) frame.hooks[index] = { current: init === undefined ? null : init };
      return frame.hooks[index];
    },
  };

  /** 把元素树真正展开成宿主树；函数/类组件都会被调用（class 的 render 也会跑）。 */
  function renderTree(node) {
    if (node === null || node === undefined || node === true || node === false) return null;
    if (Array.isArray(node)) {
      const out = [];
      for (const child of node) {
        const rendered = renderTree(child);
        if (rendered === null) continue;
        if (Array.isArray(rendered)) out.push(...rendered);
        else out.push(rendered);
      }
      return out;
    }
    if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) };
    if (typeof node !== 'object') return null;

    const { type } = node;
    if (typeof type === 'function') {
      const isClass = typeof type.prototype?.render === 'function';
      if (isClass) {
        const instance = new type(node.props);
        instance.props = node.props;
        if (instance.state === undefined) instance.state = {};
        return renderTree(instance.render());
      }
      const previous = frame;
      const own = { hooks: [], index: 0, effects: [] };
      frame = own;
      let output;
      try {
        output = type(node.props);
      } finally {
        frame = previous;
      }
      const rendered = renderTree(output);
      // 子元素渲染完（ref 已挂上）再跑 effect，与 React 的提交顺序一致。
      for (const effect of own.effects) {
        try {
          effect();
        } catch {
          // effect 抛错不该让这条结构断言挂掉（渲染结构已经拿到了）。
        }
      }
      return rendered;
    }

    const element = { kind: 'host', type, props: node.props ?? {}, children: [] };
    const kids = [];
    for (const child of node.children) {
      const rendered = renderTree(child);
      if (rendered === null) continue;
      if (Array.isArray(rendered)) kids.push(...rendered);
      else kids.push(rendered);
    }
    element.children = kids;
    const ref = element.props.ref;
    if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = { offsetWidth: 0, offsetLeft: 0 };
    return element;
  }

  function walk(node, visit) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
      return;
    }
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
  }
  const findAll = (node, predicate) => {
    const out = [];
    walk(node, (item) => {
      if (item.kind === 'host' && predicate(item)) out.push(item);
    });
    return out;
  };
  const findBy = (node, predicate) => findAll(node, predicate)[0] ?? null;
  const texts = (node) => {
    const out = [];
    walk(node, (item) => {
      if (item.kind === 'text') out.push(item.text);
    });
    return out;
  };

  // 渲染用的快照：三个入口全开，才拿得到卡片本体。
  const viewSnapshot = { ...snapshot, showInMain: true, showInPlugins: true, showInSettings: true };
  const viewOptions = { wavs: ['Alarm03.wav', 'notify.wav'], voices: ['Microsoft Huihui Desktop'] };
  const fetchStub = async (url, init) => {
    if ((init?.method ?? 'GET') === 'POST') {
      const payload = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, status: 200, json: async () => ({ values: payload.values, expected: payload.values, defaults: viewSnapshot, options: viewOptions }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ values: viewSnapshot, expected: viewSnapshot, defaults: viewSnapshot, options: viewOptions }),
    };
  };
  let viewFactory = null;
  // 同一份源码既拿去求值渲染，也拿去抽 `STRICT_MODE_TIP`（下面要比对 title 是否逐字等于它）。
  const viewSource = readFileSync(`${SRC}/client.js`, 'utf8');
  new Function('window', 'fetch', 'Headers', viewSource)(
    {
      __ModuleLoader__: {
        load(entry) {
          viewFactory = entry.factory;
        },
      },
    },
    fetchStub,
    class Headers {
      constructor(init) {
        this.init = init;
      }
    },
  );
  assert.ok(viewFactory !== null, 'client.js 没有调用 __ModuleLoader__.load（渲染段）');
  const viewMod = viewFactory(() => MiniReact);
  const viewRegistered = [];
  viewMod.apply({
    slots: {
      inject(name, register) {
        register();
      },
      register(spec, component) {
        viewRegistered.push({ spec, component });
        return () => {};
      },
    },
  });
  // apply() 里 `void refreshConfig()`：等预加载落进模块级缓存，卡片首帧才是完整表单。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cardSlot = viewRegistered.find((entry) => entry.spec.name === 'plugins.bundle.config');
  assert.ok(cardSlot, '没有 plugins.bundle.config 注册（渲染段拿不到卡片）');
  const card = renderTree(MiniReact.createElement(cardSlot.component, {}));
  assert.ok(card !== null, '设置卡片渲染成了 null（三个入口都是开着的）');

  // ---- 条件表：10 行 × (4 开关 + 1 播报文本) ----
  const conditionRows = findAll(card, (item) => item.props.className === 'ala-trow');
  assert.strictEqual(conditionRows.length, 10, `条件表应有 10 行，实际 ${conditionRows.length}`);
  for (const [index, row] of conditionRows.entries()) {
    const switches = findAll(row, (item) => item.type === 'input' && item.props.type === 'checkbox');
    assert.strictEqual(switches.length, 4, `第 ${index + 1} 行应有 4 个开关，实际 ${switches.length}`);
    const voiceInputs = findAll(row, (item) => item.type === 'input' && item.props.className === 'ala-voice-input');
    assert.strictEqual(voiceInputs.length, 1, `第 ${index + 1} 行应有恰好 1 个播报文本输入，实际 ${voiceInputs.length}`);
  }
  // 「语音播报关掉 → 该行播报文本输入框 disabled」：关掉第一行的语音播报再看那一个框。
  const firstRowSwitches = findAll(conditionRows[0], (item) => item.type === 'input' && item.props.type === 'checkbox');
  const voiceSwitch = firstRowSwitches.find((item) => String(item.props['aria-label'] ?? '').startsWith('语音播报：'));
  assert.ok(voiceSwitch, '第一行没有「语音播报」开关');
  const firstVoiceInput = () => findAll(conditionRows[0], (item) => item.type === 'input' && item.props.className === 'ala-voice-input')[0];
  assert.strictEqual(firstVoiceInput().props.disabled, voiceSwitch.props.checked !== true, '播报文本的 disabled 必须跟着「语音播报」开关走');

  // ---- 表头两行 ----
  const head = findBy(card, (item) => item.props.className === 'ala-thead');
  assert.ok(head !== null, '条件表缺表头（.ala-thead）');
  // 7 列 × 2 行 = 14 格；第一行 7 格、第二行 7 格。
  assert.strictEqual(head.children.length, 14, `表头应是两行 × 7 列 = 14 格，实际 ${head.children.length}`);
  const headSwitches = findAll(head, (item) => item.type === 'input' && item.props.type === 'checkbox');
  assert.strictEqual(headSwitches.length, 4, `表头第一行应有 4 个通道总开关，实际 ${headSwitches.length}`);
  // 第二行（后 7 格）是纯文字标签，不该再出现任何控件。
  assert.strictEqual(
    findAll({ kind: 'host', type: 'div', props: {}, children: head.children.slice(7) }, (item) => item.type === 'input').length,
    0,
    '表头第二行只应有文字标签，不该有控件',
  );
  const headTexts = texts(head);
  for (const label of ['条件', '提醒', '弹窗', '铃声', '语音播报', '播报文本']) {
    assert.ok(headTexts.includes(label), `表头第二行缺「${label}」`);
  }

  // ---- 协议模式：分段控件（2 个选项，值不变）----
  const segment = findBy(card, (item) => item.props.className === 'ala-seg');
  assert.ok(segment !== null, '协议模式没有渲染成分段控件（.ala-seg）');
  const segmentOptions = findAll(segment, (item) => item.props.className === 'ala-seg-opt');
  assert.deepStrictEqual(
    segmentOptions.map((item) => item.props['data-value']),
    ['tag-first', 'tag-only'],
    '分段控件应是 默认模式(tag-first) / 严格模式(tag-only) 两项',
  );
  assert.strictEqual(segmentOptions[0].props['data-selected'], 'true', '默认模式应初始选中');

  // ---- 严格模式说明：15×15 的 `?` 徽标 + **自绘说明卡片**（不再用原生 title）----
  // `STRICT_MODE_TIP` 是 client.js 里的模块内常量，这里从源码把它求值出来做逐字比对，
  // 免得测试里再抄一份文案（抄一份就会漂移）。
  const tipLiteral = viewSource.match(/const STRICT_MODE_TIP =\s*([\s\S]*?);\n/u);
  assert.ok(tipLiteral !== null, 'client.js 缺 `const STRICT_MODE_TIP = …` 声明');
  const STRICT_MODE_TIP = new Function(`return ${tipLiteral[1]};`)();
  assert.strictEqual(typeof STRICT_MODE_TIP, 'string', 'STRICT_MODE_TIP 必须是字符串');
  assert.strictEqual(STRICT_MODE_TIP.split('\n').length, 2, 'STRICT_MODE_TIP 应是两段（一个换行）');

  const badges = findAll(card, (item) => item.props?.['aria-label'] === '严格模式说明');
  assert.strictEqual(badges.length, 1, `「严格模式」后面的 ? 徽标应恰好 1 个，实际 ${badges.length}`);
  const badge = badges[0];
  assert.strictEqual(badge.props.className, 'ala-tip-badge', `? 徽标的 className 应是 ala-tip-badge，实际 ${badge.props.className}`);
  assert.strictEqual(badge.props.role, 'button', '? 徽标应是 role="button"（可以点击开合）');
  assert.strictEqual('title' in badge.props, false, '? 徽标不该再带 title 属性（避免原生气泡与自绘卡片两套并存）');
  assert.strictEqual(badge.props.tabIndex, 0, '? 徽标应进 Tab 序列（键盘可开合）');
  assert.strictEqual(badge.props['aria-expanded'], false, '未开合时 aria-expanded 应为 false');
  assert.strictEqual(texts(badge).join(''), '?', '? 徽标里只应有半角 `?` 一个字符');

  // 包裹层：卡片的定位基准，也是「鼠标移进卡片不算离开」的判定边界。
  const tipWrap = findBy(card, (item) => item.props.className === 'ala-tip');
  assert.ok(tipWrap !== null, '? 徽标外面应有 .ala-tip 包裹层');
  assert.strictEqual(tipWrap.props.style.position, 'relative', '包裹层应 position:relative');
  assert.strictEqual(tipWrap.props.style.display, 'inline-flex', '包裹层应 display:inline-flex');
  assert.strictEqual(tipWrap.props.style.alignItems, 'center', '包裹层应 align-items:center');
  // 徽标就在「严格模式」选项里面，且在文案之后。
  assert.ok(
    (segmentOptions[1].children ?? []).some((child) => child === tipWrap || child?.props?.className === 'ala-tip'),
    '? 徽标应挂在「严格模式」选项内部',
  );

  // 默认（未开合）整棵树里不该有卡片。
  assert.strictEqual(
    findAll(card, (item) => item.props?.role === 'tooltip').length,
    0,
    '未开合时整棵渲染树里不该有 role="tooltip" 节点',
  );

  // 把开合 state 置为 true（`defaultOpen` 这个口子只给离线自测用）：恰好 1 个 role="tooltip"，
  // 正文逐字等于 STRICT_MODE_TIP，样式逐值到位（卡片是行内 style，值就写死在 TIP_PANEL_STYLE）。
  const openTip = renderTree(MiniReact.createElement(viewMod.TipBadge, { text: STRICT_MODE_TIP, defaultOpen: true }));
  const tipPanels = findAll(openTip, (item) => item.props?.role === 'tooltip');
  assert.strictEqual(tipPanels.length, 1, `开合后应有恰好 1 个 role="tooltip" 节点，实际 ${tipPanels.length}`);
  const tipPanel = tipPanels[0];
  assert.strictEqual(texts(tipPanel).join(''), STRICT_MODE_TIP, '卡片正文必须**逐字**等于 STRICT_MODE_TIP');
  assert.strictEqual(texts(tipPanel).join('').length, STRICT_MODE_TIP.length, '卡片正文长度必须等于 STRICT_MODE_TIP 长度');
  const openBadge = findBy(openTip, (item) => item.props?.['aria-label'] === '严格模式说明');
  assert.strictEqual(openBadge.props['aria-expanded'], true, '开合后 aria-expanded 应为 true');
  const panelStyle = tipPanel.props.style ?? {};
  const styleWanted = {
    position: 'absolute',
    top: '24px',
    left: '0',
    zIndex: 30,
    pointerEvents: 'auto',
    width: 'min(360px, 64vw)',
    maxHeight: '240px',
    overflowY: 'auto',
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid rgba(128,128,128,.28)',
    background: 'var(--dsw-alias-bg-elevated, #ffffff)',
    boxShadow: '0 8px 24px rgba(0,0,0,.18)',
    fontSize: '12px',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    color: 'var(--dsw-alias-label-primary, #111827)',
  };
  for (const [key, wanted] of Object.entries(styleWanted)) {
    assert.strictEqual(panelStyle[key], wanted, `说明卡片 style.${key} 应是 ${JSON.stringify(wanted)}，实际 ${JSON.stringify(panelStyle[key])}`);
  }

  // 旧气泡那套（`.ala-tip-bubble`）必须彻底消失：渲染树没有、源码也没有残留规则。
  assert.strictEqual(
    findAll(card, (item) => String(item.props?.className ?? '').includes('tip-bubble')).length,
    0,
    '整棵渲染树里不该再有任何 tip-bubble 类',
  );
  assert.strictEqual(viewSource.includes('tip-bubble'), false, 'client.js 源码里不该再有 tip-bubble（含孤儿 CSS 规则）');
  // 卡片确实是自绘的（源码里挂着 role="tooltip" 的节点），不是靠原生 title。
  assert.ok(viewSource.includes("role: 'tooltip'"), 'client.js 里应有自绘说明卡片（role="tooltip"）');

  // ---- TTS 分区瘦身：逐条件播报文本字段不该再出现在分区里 ----
  const cardTexts = texts(card);
  for (const label of ['「需要你裁决」播报文本', '「本轮报错」播报文本', '「任务到待人工测试」播报文本', '兜底播报模板']) {
    assert.strictEqual(cardTexts.includes(label), false, `TTS 分区里不该再有「${label}」（已上移到条件表最后一列）`);
  }
  assert.ok(cardTexts.includes('兜底文本'), 'TTS 分区缺「兜底文本」');
  const voiceLabels = findAll(card, (item) => String(item.props?.['aria-label'] ?? '').startsWith('播报文本：'));
  assert.strictEqual(voiceLabels.length, 10, `条件表最后一列应有 10 个播报文本输入，实际 ${voiceLabels.length}`);
  // 那 10 个键仍在键表里（TTS 分区搬走不等于字段消失）。
  const tenVoiceKeys = ['Ask', 'Plan', 'TaskComplete', 'TurnEnd', 'Interrupt', 'Error', 'Stalled', 'AwaitingTest', 'Restart', 'Test'];
  for (const kind of tenVoiceKeys) assert.ok(viewMod.missingFieldKeys({}).includes(`voiceText${kind}`), `键表缺 voiceText${kind}`);
  console.log(
    'client 渲染结构 ok: 条件表 %d 行 × (4 开关 + 1 播报文本)、表头 2 行 × 7 列（4 个总开关）、协议模式分段 2 项、? 徽标点开自绘卡片（%d 字符、无 title 属性、开合 0→1 个 tooltip 节点）、TTS 分区无逐条件字段',
    conditionRows.length,
    STRICT_MODE_TIP.length,
  );
}

// ---------------- 清理临时 DSH_HOME ----------------
// 上传用例往里面写过 wav；预热脚本（materializeScript）也落在这里。跑完一律删掉。
rmSync(HOME, { recursive: true, force: true });
assert.strictEqual(existsSync(HOME), false, '临时 DSH_HOME 应被清掉（不留下测试残留）');
console.log('cleanup ok: 临时 DSH_HOME 已删除（%s）', HOME);

console.log('\nALL CHECKS PASSED');
