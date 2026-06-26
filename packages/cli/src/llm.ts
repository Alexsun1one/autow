/**
 * @autow/cli —— BYOK LLM 客户端(Vercel AI SDK 适配)。
 *
 * 为什么在这里自己实现,而不是直接用 engine 的 createVercelLlm?
 *   - @autow/engine 只对外暴露 provider 无关的 LlmClient 接口契约;
 *   - engine 内的 createVercelLlm 适配器「故意不从 index 导出」(避免未装 ai 的消费者被牵连),
 *     且 engine 的 package.json exports 只暴露根入口,无法深度导入 llm/vercel.js;
 *   - 因此 CLI 在这里实现一个与 createVercelLlm 同构的 BYOK 客户端,复用 @autow/engine 的
 *     LlmClient / LlmConfig 类型契约,以及 workspace 已有的 ai SDK 依赖(不引入新依赖)。
 *
 * 实现与 engine 的 createVercelLlm 对齐:
 *   - openai-compatible 通吃(DeepSeek / Moonshot / SiliconFlow / 自部署 / OpenAI),
 *     provider==="anthropic" 单独走 createAnthropic;
 *   - 流式:有 onToken → streamText 逐字回调,否则 generateText;
 *   - 结构化:generateObject(provider 原生约束),失败回退纯文本 + JSON 抽取 + zod 校验,
 *     严格性由调用方传入的 schema 守住。
 */
import { generateText, streamText, generateObject } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type {
  LlmConfig,
  LlmClient,
  LlmCallOptions,
  LlmStructuredResult,
} from "@autow/engine";
import type { ModelTier } from "@autow/engine";

export interface CliLlmConfig {
  /** 强模型(规划/写作/审稿/修订/判官)*/
  readonly strong: LlmConfig;
  /** 快模型(润色等;缺省回落到 strong)*/
  readonly fast?: LlmConfig;
}

// 已知 OpenAI 兼容端的默认 baseURL(BYOK 显式给 baseUrl 时以用户为准)。
// createOpenAICompatible 要求 baseURL 必填。
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  kimi: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  // 本机/自部署端点请在 LlmConfig.baseUrl 显式给出。
};

function buildModel(cfg: LlmConfig) {
  const headers = cfg.extraHeaders;
  if (cfg.provider === "anthropic") {
    const anthropic = createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, headers });
    return anthropic(cfg.model);
  }
  const baseURL = cfg.baseUrl ?? DEFAULT_BASE_URLS[cfg.provider] ?? "https://api.openai.com/v1";
  const provider = createOpenAICompatible({
    name: cfg.provider || "openai-compatible",
    apiKey: cfg.apiKey,
    baseURL,
    headers,
    // BYOK 全兼容:多数兼容端(DeepSeek/Kimi/自部署)不支持 json_schema response_format,
    // 关掉它 → generateObject 退回 json_object 模式(把 schema 注入提示词 + 客户端 zod 校验),
    // 结构化输出在任意兼容端都能跑;严格性由调用方的 zod 守住,不丢。
    supportsStructuredOutputs: false,
  });
  return provider(cfg.model);
}

function toMessages(opts: LlmCallOptions) {
  return opts.messages.map((m) => ({ role: m.role, content: m.content }));
}

// 容错抽取模型返回里的 JSON(剥 ```json 围栏 / 前后缀解说,取最外层 { } 或 [ ])。
function extractJson(text: string): unknown {
  let s = (text ?? "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error(`模型未返回 JSON(疑似纯文本拒答):${(text ?? "").slice(0, 120)}`);
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  if (end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`模型输出的 JSON 无法解析:${s.slice(0, 120)}`);
  }
}

// 单次模型调用硬超时:provider 卡死时不致整条流水线无限挂起。
const CALL_TIMEOUT_MS = 180_000;

function callSignal(sig?: AbortSignal): AbortSignal | undefined {
  let timeout: AbortSignal | undefined;
  try {
    timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  } catch {
    timeout = undefined;
  }
  if (!timeout) return sig;
  if (sig) {
    try {
      return AbortSignal.any([timeout, sig]);
    } catch {
      return sig;
    }
  }
  return timeout;
}

/**
 * 构造一个 BYOK LlmClient。按调用的 modelTier 切强/快模型(fast 缺省回落 strong)。
 */
export function createCliLlm(cfg: CliLlmConfig): LlmClient {
  const pick = (tier?: ModelTier): LlmConfig => (tier === "fast" && cfg.fast ? cfg.fast : cfg.strong);

  return {
    async generate(opts: LlmCallOptions) {
      const conf = pick(opts.modelTier);
      const base = {
        model: buildModel(conf),
        system: opts.system,
        messages: toMessages(opts),
        temperature: opts.temperature ?? conf.temperature,
        maxOutputTokens: opts.maxOutputTokens ?? conf.maxOutputTokens,
        abortSignal: callSignal(opts.signal instanceof AbortSignal ? opts.signal : undefined),
      };
      if (opts.onToken) {
        const result = streamText(base);
        for await (const delta of result.textStream) opts.onToken(delta);
        const [text, usage] = await Promise.all([result.text, result.usage]);
        return { text, tokens: usage?.totalTokens };
      }
      const { text, usage } = await generateText(base);
      return { text, tokens: usage?.totalTokens };
    },

    async generateStructured<S extends z.ZodTypeAny>(
      opts: LlmCallOptions & { schema: S },
    ): Promise<LlmStructuredResult<z.infer<S>>> {
      const conf = pick(opts.modelTier);
      const base = {
        model: buildModel(conf),
        system: opts.system,
        messages: toMessages(opts),
        temperature: opts.temperature ?? conf.temperature,
        maxOutputTokens: opts.maxOutputTokens ?? conf.maxOutputTokens,
        abortSignal: callSignal(opts.signal instanceof AbortSignal ? opts.signal : undefined),
      };
      try {
        const { object, usage } = await generateObject({ ...base, schema: opts.schema });
        return { data: object, tokens: usage?.totalTokens };
      } catch {
        // 兜底:多数 OpenAI 兼容端不支持 json_schema 强约束,generateObject 会失败。
        // 退回纯文本 + 强 JSON 指令 + 容错解析,严格性由调用方的 zod.parse 守住。
        const sys = `${opts.system}\n\n【输出格式】只输出一个 JSON 对象,严格对应所需结构;不要 markdown 代码围栏,不要任何解释或前后缀文字。`;
        const { text, usage } = await generateText({ ...base, system: sys });
        const data = opts.schema.parse(extractJson(text));
        return { data, tokens: usage?.totalTokens };
      }
    },
  };
}
