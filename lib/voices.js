/** 系统已安装 TTS 语音的枚举与分类（设置页的语音下拉与报警投递的
 *  「网络音色失败 → 回退本机离线音色」共用同一份实现，避免两处口径漂移）。
 *
 *  为什么要分类：本机的语音有两套来源——
 *    1. Windows 自带的 SAPI5 离线音色（如 `Microsoft Huihui Desktop`），不联网也能念；
 *    2. 第三方 SAPI 桥 VoiceGardenSAPI（RustTts / edge 引擎）提供的 `*Neural` 音色，
 *       名字里带 Neural，**必须联网**。服务端 403 时 `SpeechSynthesizer.Speak()`
 *       既不抛异常也不出声，只在 stderr 留一行 `[warning] RustTts::Engine::Speak failed`。
 *  判定只能看名字里的 `Neural`：这类音色的 `VoiceInfo.Culture` 会误报 en-US，
 *  按 culture 挑「中文音色」会挑错。
 *
 *  枚举走一次 PowerShell 5.1（命令行保持纯 ASCII），结果缓存 5 分钟。
 */

import { spawnSync } from "node:child_process";

/** 语音名缓存（枚举一次约 1~2 秒，设置页每次拉配置都会问）。 */
const VOICES_TTL_MS = 5 * 60 * 1000;
let voicesCache = { at: 0, names: [] };

/** 枚举系统已安装且启用中的语音名；失败给空数组（绝不抛）。 */
export function listInstalledVoices(logger) {
	const now = Date.now();
	if (voicesCache.at !== 0 && now - voicesCache.at < VOICES_TTL_MS) return voicesCache.names;
	const script = [
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
		"Add-Type -AssemblyName System.Speech;",
		"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
		"$s.GetInstalledVoices() | ForEach-Object { if ($_.Enabled) { $_.VoiceInfo.Name } } | ConvertTo-Json -Compress;",
		"$s.Dispose();",
	].join(" ");
	let names = [];
	try {
		const result = spawnSync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ encoding: "utf8", timeout: 10_000, windowsHide: true },
		);
		const text = typeof result?.stdout === "string" ? result.stdout.trim() : "";
		if (text !== "") {
			const parsed = JSON.parse(text);
			const list = Array.isArray(parsed) ? parsed : [parsed];
			names = list.filter((name) => typeof name === "string" && name !== "");
		}
	} catch (error) {
		logger?.warn?.(`dsh-alarm: 语音枚举失败：${error?.message ?? error}`);
		names = [];
	}
	voicesCache = { at: now, names };
	return names;
}

/** 是否「需要联网」的神经网络音色：名字含 Neural（不区分大小写）。
 *  这类音色由第三方 VoiceGardenSAPI 提供，离线或服务端 403 时一声不出。 */
export function isNetworkVoice(name) {
	return typeof name === "string" && /neural/i.test(name);
}

/** 从语音列表里挑第一个本机离线音色（名字不含 Neural）；
 *  没有则返回 ""（= 脚本不 SelectVoice，用系统默认音色）。 */
export function pickOfflineVoice(voices) {
	if (!Array.isArray(voices)) return "";
	for (const name of voices) {
		if (typeof name === "string" && name !== "" && !isNetworkVoice(name)) return name;
	}
	return "";
}
