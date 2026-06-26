/**
 * @autow/cli —— 配置解析。
 *
 * 优先级:CLI flags > 环境变量(AUTOW_LLM_*) > 配置文件(autow.config.json) > 内置默认。
 * LLM 部分构造出 @autow/engine 的 LlmConfig(强模型 + 可选快模型),交给 createCliLlm。
 * 不读 .env(如需,在 shell 里 `set -a; . .env; set +a` 或 `node --env-file=.env` 即可)。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LlmConfig } from "@autow/engine";
import { deriveBookIdFromTitle } from "@autow/core";

// 支持的平台 ID(与 @autow/core 的 renderForPlatform 入参对齐)。
export type RenderPlatform = "wechat" | "zhihu" | "xiaohongshu" | "x" | "newsletter";

const RENDER_PLATFORMS: readonly RenderPlatform[] = ["wechat", "zhihu", "xiaohongshu", "x", "newsletter"];

// 已知 OpenAI 兼容端的默认 baseURL(provider 命中时,baseUrl 可省略)。
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  kimi: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
};

/** parseArgs 解析出的原始 flag(均为可选字符串)。 */
export interface CliFlags {
  title?: string;
  goal?: string;
  premise?: string;
  biblePath?: string;
  lang?: string;
  words?: string;
  chapter?: string;
  bookId?: string;
  out?: string;
  platform?: string;
  qualityThreshold?: string;
  maxReviseRounds?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fastModel?: string;
  temperature?: string;
  maxTokens?: string;
  configPath?: string;
}

export interface ResolvedConfig {
  llm: { strong: LlmConfig; fast?: LlmConfig };
  title: string;
  goal: string;
  premise: string;
  bible: string;
  lang: "zh" | "en";
  words: number;
  chapter: number;
  bookId: string;
  out: string;
  platform?: RenderPlatform;
  qualityThreshold: number;
  maxReviseRounds: number;
}

interface RawFileConfig {
  llm?: {
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    fastModel?: string;
    temperature?: number;
    maxTokens?: number;
  };
  title?: string;
  goal?: string;
  premise?: string;
  bible?: string;
  biblePath?: string;
  lang?: "zh" | "en";
  words?: number;
  chapter?: number;
  bookId?: string;
  out?: string;
  platform?: string;
  qualityThreshold?: number;
  maxReviseRounds?: number;
}

const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() ? v : undefined;
};

const pick = (...vals: Array<string | undefined>): string | undefined =>
  vals.find((v) => v && v.trim());

const pickNum = (...vals: Array<number | undefined>): number | undefined =>
  vals.find((v) => typeof v === "number" && Number.isFinite(v)) as number | undefined;

function readConfigFile(path: string): RawFileConfig {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as RawFileConfig;
  } catch (e) {
    throw new Error(`配置文件 ${path} 不是合法 JSON:${e instanceof Error ? e.message : String(e)}`);
  }
}

function combineBible(premise: string, bible: string): string {
  const p = premise.trim();
  const b = bible.trim();
  if (p && b) return `${p}\n\n${b}`;
  return p || b;
}

/**
 * 解析并校验最终配置。优先级:flags > env > file > defaults。
 * @param flags  parseArgs 结果(已把位置参数归并进 flags.title)
 */
export function resolveConfig(flags: CliFlags): ResolvedConfig {
  const file = (() => {
    const path = resolve(flags.configPath ?? "autow.config.json");
    if (existsSync(path)) return readConfigFile(path);
    if (flags.configPath) {
      throw new Error(`指定的配置文件不存在:${path}`);
    }
    return {} as RawFileConfig;
  })();
  const f = file; // 别名,缩短下面引用

  // ── LLM ──
  const provider = pick(
    flags.provider,
    env("AUTOW_LLM_PROVIDER"),
    f.llm?.provider,
  ) ?? "openai-compatible";

  const baseUrl = pick(
    flags.baseUrl,
    env("AUTOW_LLM_BASE_URL"),
    f.llm?.baseUrl,
  ) ?? DEFAULT_BASE_URLS[provider];

  const apiKey = pick(
    flags.apiKey,
    env("AUTOW_LLM_API_KEY"),
    f.llm?.apiKey,
  );

  const model = pick(
    flags.model,
    env("AUTOW_LLM_MODEL"),
    f.llm?.model,
  );
  if (!model) {
    throw new Error(
      "缺少 LLM 模型:请用 --model、环境变量 AUTOW_LLM_MODEL 或配置文件 llm.model 指定(例:deepseek-chat / gpt-4o-mini / qwen-plus)。",
    );
  }

  const fastModel = pick(
    flags.fastModel,
    env("AUTOW_LLM_FAST_MODEL"),
    f.llm?.fastModel,
  );

  const temperatureRaw = pickNum(
    flags.temperature ? Number(flags.temperature) : undefined,
    env("AUTOW_LLM_TEMPERATURE") ? Number(env("AUTOW_LLM_TEMPERATURE")) : undefined,
    f.llm?.temperature,
  );
  const temperature =
    typeof temperatureRaw === "number" && Number.isFinite(temperatureRaw)
      ? Math.max(0, Math.min(2, temperatureRaw))
      : undefined;

  const maxTokensRaw = pickNum(
    flags.maxTokens ? Number(flags.maxTokens) : undefined,
    env("AUTOW_LLM_MAX_TOKENS") ? Number(env("AUTOW_LLM_MAX_TOKENS")) : undefined,
    f.llm?.maxTokens,
  );
  const maxOutputTokens =
    typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
      ? Math.round(maxTokensRaw)
      : undefined;

  if (!baseUrl) {
    throw new Error(
      `缺少 LLM baseURL:provider="${provider}" 无内置默认地址,请用 --base-url、AUTOW_LLM_BASE_URL 或配置文件 llm.baseUrl 指定(OpenAI 兼容端点,含 /v1)。`,
    );
  }

  const strong: LlmConfig = { provider, model, baseUrl };
  if (apiKey) strong.apiKey = apiKey;
  if (temperature !== undefined) strong.temperature = temperature;
  if (maxOutputTokens !== undefined) strong.maxOutputTokens = maxOutputTokens;

  let fast: LlmConfig | undefined;
  if (fastModel) {
    fast = { provider, model: fastModel, baseUrl };
    if (apiKey) fast.apiKey = apiKey;
    if (temperature !== undefined) fast.temperature = temperature;
    if (maxOutputTokens !== undefined) fast.maxOutputTokens = maxOutputTokens;
  }

  // ── 书 / 章节 ──
  const title = pick(flags.title, f.title) ?? "";
  const premise = pick(flags.premise, f.premise) ?? "";
  const bibleInline = pick(f.bible) ?? "";
  const biblePath = pick(flags.biblePath, f.biblePath);
  const bible = biblePath ? readFileSync(resolve(biblePath), "utf8") : bibleInline;

  const langRaw = pick(flags.lang, f.lang) ?? "zh";
  const lang: "zh" | "en" = langRaw === "en" ? "en" : "zh";

  const words = pickNum(
    flags.words ? Number(flags.words) : undefined,
    f.words,
  ) ?? 3000;

  const chapter = pickNum(
    flags.chapter ? Number(flags.chapter) : undefined,
    f.chapter,
  ) ?? 1;

  const bookId = pick(flags.bookId, f.bookId) ?? deriveBookIdFromTitle(title || "autow-book");

  const out = pick(flags.out, f.out) ?? `out/chapter-${chapter}.md`;

  const qualityThreshold = pickNum(
    flags.qualityThreshold ? Number(flags.qualityThreshold) : undefined,
    f.qualityThreshold,
  ) ?? 80;

  const maxReviseRounds = pickNum(
    flags.maxReviseRounds ? Number(flags.maxReviseRounds) : undefined,
    f.maxReviseRounds,
  ) ?? 1;

  let platform: RenderPlatform | undefined;
  const platformRaw = pick(flags.platform, f.platform);
  if (platformRaw) {
    if (!RENDER_PLATFORMS.includes(platformRaw as RenderPlatform)) {
      throw new Error(
        `不支持的 --platform "${platformRaw}",可选:${RENDER_PLATFORMS.join(", ")}。`,
      );
    }
    platform = platformRaw as RenderPlatform;
  }

  return {
    llm: { strong, fast },
    title,
    goal: pick(flags.goal, f.goal) ?? defaultGoal(lang, chapter, title),
    premise,
    bible: combineBible(premise, bible),
    lang,
    words,
    chapter,
    bookId,
    out,
    platform,
    qualityThreshold,
    maxReviseRounds,
  };
}

function defaultGoal(lang: "zh" | "en", chapter: number, title: string): string {
  if (lang === "en") {
    return title
      ? `Write chapter ${chapter} of "${title}": establish the protagonist's situation and plant the first suspense hook.`
      : `Write chapter ${chapter}: establish the protagonist's situation and plant the first suspense hook.`;
  }
  return title
    ? `为《${title}》写第 ${chapter} 章:建立主角处境,埋下第一个悬念。`
    : `写第 ${chapter} 章:建立主角处境,埋下第一个悬念。`;
}
