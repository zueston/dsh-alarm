/** 离线自检：不启动 DSH，直接用假 ctx 跑 host/routes.js 的路由与 client.js 的 slot 注册。
 *
 *  覆盖面（改了产品代码就照着这份清单核对）：
 *   - **4 条路由**（全部 kind=exact）：`/api/dsh-alarm/config`、`/api/dsh-alarm/test`、
 *     `/api/dsh-alarm/agent-rules`、`/api/dsh-alarm/health`；
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
 *     + 大小写错误不匹配 + TEST 空任务名。
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
  // 「Agent 停下来且没有后续动作」默认开；与其它轻事件一样默认不弹窗。
  assert.strictEqual(payload.values.alertStalled, true);
  assert.strictEqual(payload.values.soundStalled, true);
  assert.strictEqual(payload.values.voiceStalled, true);
  assert.strictEqual(payload.values.popupStalled, false);
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
  // 轻事件默认不弹窗；需要你动手的三件事 + 待人工测试 + 测试按钮默认弹窗。
  for (const kind of ['Ask', 'Plan', 'TaskComplete', 'AwaitingTest', 'Test']) {
    assert.strictEqual(payload.values[`popup${kind}`], true, `popup${kind} 默认应为 true`);
  }
  for (const kind of ['Restart', 'TurnEnd', 'TurnInterrupt', 'TurnError', 'Stalled']) {
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

console.log('\nALL CHECKS PASSED');
