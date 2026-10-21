# dsh-alarm

DSH 独立提醒报警插件：root 会话需要你裁决、需要你确认计划、或这一轮结束时，用系统铃声、TTS 语音播报与弹窗把你叫回来。自带一张可视化设置页（侧边栏「报警提醒」入口）与 9 种可独立勾选的报警条件。

> A standalone alarm/notification plugin for the DSH desktop app: when the root agent needs your decision, needs your plan approval, or a turn ends, it plays a Windows system sound, speaks a TTS message and/or shows a popup. Nine independent alert conditions, four channels, and a built-in settings page. Windows only, local only.

---

## 功能特性

- **9 种报警条件**，每种一个独立开关（默认只开「需要你裁决 / 确认计划 / 全部任务完成 / 需要重启 DSH / 任务到待人工测试 / 手工测试」这几项中的关键项，见[报警条件一览](#报警条件一览)）。
- **四条通道**：`提醒`（这个条件响不响）/ `弹窗` / `铃声` / `语音播报`。三个通道各有**总开关**（条件表表头那一行），与逐条件开关是「与」关系——提醒与通道都勾上才会真的响。
- **每行 ▶ 试听**：按设置页**当前勾选**（含还没保存的改动）立刻模拟一次该条件的提醒，只响这一次、不改配置。
- **勾选即自动保存**（400ms 防抖），不再有「勾了但没点保存」；底部「保存」按钮保留为手动重试入口，「重新载入」丢弃本地改动回到磁盘配置。
- **弹窗两种模式**：强弹窗（置顶窗口，显示几秒后自动关闭，不挡桌面操作）/ 系统消息（只发 Windows 通知，完全不弹窗口）。
- 铃声取自系统 `%SystemRoot%\Media\*.wav`，可调重复次数（1–5）；语音走 Windows 自带 SAPI，可调语速/音量/音色，每条提醒可自定义播报文本（留空回落到底部兜底模板 `{title}。{body}`）。
- 配置存在 **DSH profile 的 `cordis.patch.yml`**（设置命名空间 `dsh-alarm`），保存后**立刻生效**，无需重载插件、无需重启。
- **只对 root（主）会话提醒**：子智能体的会话一律不响。
- **绝不打断对话**：每次投递都 spawn 一个隐藏窗口的独立进程，任何失败都被吞掉，只写一行诊断日志。

## 环境要求

| 项 | 要求 |
| --- | --- |
| 宿主 | DSH 桌面版（插件依赖宿主的 `agents` / `settings` / `webServer` 三个服务，客户端半体走 `web` 平台 bundle） |
| 操作系统 | Windows（弹窗走 WinRT toast，铃声/语音走 Windows 自带组件） |
| Node.js | ≥ 24 |
| PowerShell | **Windows PowerShell 5.1**（`powershell.exe`，不是 `pwsh` 7：WinRT toast 在 .NET Core PowerShell 里没有投影） |
| 系统组件 | Windows 自带的 SAPI 语音（`System.Speech`）与 `%SystemRoot%\Media\*.wav` 系统铃声 |
| 依赖 | `@deepseek-ai/schemastery`（设置 schema） |

## 安装

1. 把本仓库放到 DSH 的插件源码目录（目录名随意，习惯用插件名）：

   ```text
   %USERPROFILE%\.dsh\plugin-src\dsh-alarm\
   ```

   然后在插件目录里装依赖：

   ```powershell
   cd "$env:USERPROFILE\.dsh\plugin-src\dsh-alarm"
   npm install
   ```

2. 在你的 **profile 的 `cordis.patch.yml`** 里挂载本插件。示意片段（**键名与层级以你该文件里现有条目为准**，下面是形状示例，不是可直接粘贴的成品）：

   ```yaml
   plugins:
     - id: dsh-alarm          # 必须叫 dsh-alarm：设置命名空间就是这个 loader 行 id
       name: 'dsh-alarm'
       config:                # 整段都可以省略：所有字段都有默认值
         enabled: true
         popupStyle: topmost  # topmost=强弹窗 / toast=系统消息
         sound: Alarm03.wav
         soundRepeats: 1
   ```

   > `id` 必须是 `dsh-alarm`：设置页的写回按 loader 行 id 查找条目（不是按 `name`）。

3. 重启 DSH。侧边栏出现铃铛入口「报警提醒」，设置页出现「报警提醒（dsh-alarm）」卡片。

## 使用

1. **侧边栏「报警提醒」**（铃铛图标）→ 点开设置浮层；设置页与「插件」页里也能进同一张表单。
2. **条件表怎么勾**：一行一个条件。最左边的 **▶** 按当前设置试听这一行（只响这一次，不改配置）；`提醒` 列决定这个条件响不响；右边 `弹窗` / `铃声` / `语音播报` 三列决定它用哪几条通道。
3. **四个通道总开关**：条件表**表头那一行**的四个复选框就是总开关（`提醒` → `enabled`、`弹窗` → `popup`、`铃声` → `soundEnabled`、`语音播报` → `voice`）。关掉某条通道的总开关，所有条件都不再走这条通道。
4. **保存**：勾选即自动保存；底部「保存」按钮用于自动保存失败时手动重试，「重新载入」把表单回退到磁盘上的配置。
5. **弹窗模式**：`弹窗` 分区里选 **强弹窗**（置顶窗口，自动关闭）或 **系统消息**（Windows 通知，不弹窗口）。若弹窗通道开着、但窗口没能显示，会尽力补发一次 WinRT toast；弹窗通道关掉时 toast 也一起关。
6. **试听没声音**：先看条件表——总开关、该条件的 `提醒`、以及它用到的通道是否都勾上了（页面会直接提示「没有响：总开关、该条件或它用到的通道是关的」）。「手工测试提醒」这一行取消勾选后，该行的 ▶ 也不会响。

## 报警条件一览

| # | 条件（设置页文案） | 触发时机 | 默认 |
| --- | --- | --- | --- |
| 1 | 需要你裁决（`ask_user_question`） | 工具 `ask_user_question` 执行前——agent 停下来等你做选择 | 提醒✅ 弹窗✅ |
| 2 | 需要你确认计划（`exit_plan_mode`） | 工具 `exit_plan_mode` 执行前——agent 提交了计划等你确认 | 提醒✅ 弹窗✅ |
| 3 | 全部任务完成 | 工具 `update_goal`（`action: complete`）执行前。**这是「完成」的唯一入口**，普通轮次结束不算 | 提醒✅ 弹窗✅ |
| 4 | 需要重启 DSH | 一轮正常结束时，agent 最后一条回复**正文**里提到「要重启 DSH 才生效」。否定说法（「不需要重启」）、未来时/条件句（「等我改完再重启」）、围栏代码块里的引用都不算；命中时不再额外响「本轮结束」 | 提醒✅ 弹窗❌ |
| 5 | 任务到「待人工测试」 | 写 `03-开发协同/<任务>/状态.md` 时，该文件的「当前阶段」**真的**从别的值变成「待人工测试」（入参文本里提到这句话不算；同一状态文件 5 分钟内只响一次） | 提醒✅ 弹窗✅ |
| 6 | 每一轮结束都提醒 | `turn/end` 的 `reason.completed`（没收到 `turn/end` 时由 `agent/status` 变 idle 兜底）。可用「只有本轮耗时 ≥ N 秒才提醒结束」过滤掉短轮次 | 提醒❌ 弹窗❌ |
| 7 | 本轮中断时提醒（手动打断） | `turn/end` 的 reason 命中 `abort` / `interrupt` / `cancel` / `stop` / `user` | 提醒❌ 弹窗❌ |
| 8 | 本轮报错时提醒（异常结束） | `turn/end` 的 reason 不属于中断类（`error` / `failed` / `max-tokens` …） | 提醒❌ 弹窗❌ |
| 9 | 手工测试提醒 | 设置页的「测试提醒」按钮，以及条件表每行的 ▶ 试听 | 提醒✅ 弹窗✅ |

> 9 种条件的 `铃声` 与 `语音播报` 默认都开。除「需要重启 DSH」外的轻事件默认不弹窗，避免每轮都打断你。

## 配置项说明

字段都在设置页里（不在这里逐一罗列）：**什么时候提醒**（9 个条件 × 4 条通道 + 表头总开关）、**弹窗**（弹窗风格）、**铃声**（铃声文件、重复次数）、**语音播报（TTS）**（9 条播报文本 + 兜底模板 + 语音/语速/音量）、**节流**（短轮次过滤、同类提醒最小间隔、裁决后忽略「结束」提醒的时长）。

字段定义的唯一真源是 [`host/config.js`](host/config.js)（schema + 默认值）与 [`host/routes.js`](host/routes.js) 的 `FIELDS`（校验与默认值）。全部字段都是**扁平 volatile** 字段：每次提醒现读 config，所以设置页保存后立刻生效。

## 目录结构

```text
dsh-alarm/
├── index.js           # 宿主入口（apply + Config + inject）
├── client.js          # 浏览器半体：侧边栏入口、设置页卡片、设置浮层
├── lib/
│   ├── alarm.js       # 投递层：条件判定、节流、生成并 spawn toast-alert.ps1、诊断日志
│   └── voices.js      # 系统 TTS 音色枚举与「是否需要联网」分类
├── host/
│   ├── config.js      # 设置 schema（schemastery）
│   └── routes.js      # /api/dsh-alarm/{config,test,health} 路由
└── test/              # 离线自检（见下）
```

## 自测

```powershell
# 1) 路由与 slot 注册（不启动 DSH，用假 ctx 跑一遍）
node test/verify-routes.mjs

# 2) 「需要重启 DSH」的文本判定（纯函数，不投递、不响铃）
node test/restart-judge.mjs

# 3) 真机试听一次：真的会响铃 + 弹窗 + 语音播报（用 Windows PowerShell 5.1）
powershell -NoProfile -ExecutionPolicy Bypass -File test/selftest-launch.ps1
```

- `verify-routes.mjs` 会打一次 `/api/dsh-alarm/test`；若返回 `delivered=true` 就会**真的响铃+弹窗**（取决于你的当前配置）。
- `restart-judge.mjs` 只跑纯函数 `restartHitOf`，样本是 [`test/fixtures/restart-samples.json`](test/fixtures/restart-samples.json) 里的合成用例（明确要求重启 / 否定式 / 未来时 / 围栏引用 / 英文 / 无关文本），预期 7/7 通过。
- `selftest-launch.ps1` 会**真的出声**：它用 WMI 起一个独立进程跑 `<DSH_HOME>\alarm\toast-alert.ps1`。这个脚本由插件在**加载时预热生成**（`host/routes.js` 的 `applyRoutes` 末尾调 `materializeScript`），所以插件挂载成功就有；若报找不到文件，先确认插件已经挂上。`DSH_HOME` 缺省为 `%USERPROFILE%\.dsh`。

## 隐私与安全

- **本地运行**：插件自身**不发任何出站网络请求**，不收集、不上传任何数据。
- **唯一端点**：`/api/dsh-alarm/config`、`/api/dsh-alarm/test`、`/api/dsh-alarm/health` 只挂在宿主本机 web 服务上，且校验 Host 头与 Origin（未配对的非 loopback 请求一律 `403`）。
- **配置**：存在你自己的 DSH profile 的 `cordis.patch.yml`（命名空间 `dsh-alarm`），不写到别处。
- **日志**：诊断日志是 JSONL，位于 `<DSH_HOME>\alarm\alarm.log`（512 KB 轮转）。里面只有结构化字段——事件名、kind、跳过原因、状态文件路径与相位、sessionId、字符数——**不含对话正文，也不含提醒文案**。
- **运行时文件**：`<DSH_HOME>\alarm\toast-alert.ps1`（纯 ASCII，中文标题/正文/播报文本一律走 UTF-8 base64 参数）。
- **联网音色**：若在「语音」下拉里选了名字带 `Neural` 的**第三方** SAPI 桥提供的音色，那个音色本身需要联网（由该音色提供方负责）；插件只负责调用系统 TTS。想完全离线就选系统自带音色（名字里不带 `Neural`）。
- 报警失败一律静默（只记日志）：绝不会打断或拖垮一轮对话。

## License

[MIT](LICENSE) © 2026 zueston
