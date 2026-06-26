#!/usr/bin/env node
/**
 * @autow/cli —— 卷舍写作引擎命令行入口。
 *
 * 用 @autow/engine 的 runPipeline 跑完一章的七阶段流水线(planning→writing→reviewing→
 * revising→polishing→verifying→publishing),把成稿落到文件。LLM 走 BYOK(自带 baseURL/
 * apiKey/model)。可选 --platform 用 @autow/core 把成稿渲染成公众号/知乎等平台 HTML。
 *
 * 用法见 --help。最小示例:
 *   autow --base-url https://api.deepseek.com/v1 --api-key sk-xxx \
 *         --model deepseek-chat --title《雾港》--words 2500
 */
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runPipeline,
  type RunState,
  type StageBudget,
  type PipelineDeps,
  type WriteStage,
} from "@autow/engine";
import { markdownToContentDocument, renderForPlatform } from "@autow/core";

import { createCliLlm } from "./llm.js";
import { resolveConfig, type CliFlags } from "./config.js";
import { buildHandlers, latestDraft, countWords } from "./handlers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `autow v${readVersion()} —— 卷舍写作引擎命令行(clone 后即可命令行写一章)

用法:
  autow <书名> [选项]
  autow --title <书名> --goal <本章目标> [选项]

写作参数(命令行 > 环境变量 > autow.config.json > 默认):
  <书名>                    位置参数,等价于 --title
  --title <t>               章节/作品标题
  --goal <g>                本章写作目标/节拍(默认按章号生成一句)
  --premise <p>             作品一句话设定/主题(写入 bible)
  --bible <path>            作品设定文件路径(详尽设定,写入 bible)
  --lang zh|en              写作语言,默认 zh
  --words <n>               目标字数,默认 3000
  --chapter <n>             章号,默认 1
  --book-id <id>            书 ID(默认由标题生成)
  --out <path>              输出文件,默认 out/chapter-<n>.md
  --platform <p>            额外渲染成平台 HTML:wechat|zhihu|xiaohongshu|x|newsletter
  --quality-threshold <n>   过线分 0-100,默认 80(偏宽松以保证能跑完)
  --max-revise-rounds <n>   返修上限,默认 1

LLM(BYOK,命令行 > 环境变量 > 配置文件):
  --provider <p>            openai-compatible(默认)|anthropic|deepseek|moonshot|...
  --base-url <url>          OpenAI 兼容端点(含 /v1)
  --api-key <k>             API key(本地端点可省)
  --model <m>               强模型(规划/写作/审稿/修订/判官)[必填]
  --fast-model <m>          快模型(润色;缺省回落到 --model)
  --temperature <0-2>       采样温度
  --max-tokens <n>          单次输出 token 上限(正文阶段)
  --config <path>           配置文件路径,默认 ./autow.config.json

环境变量(与同名 --flag 等价):AUTOW_LLM_PROVIDER / AUTOW_LLM_BASE_URL /
  AUTOW_LLM_API_KEY / AUTOW_LLM_MODEL / AUTOW_LLM_FAST_MODEL /
  AUTOW_LLM_TEMPERATURE / AUTOW_LLM_MAX_TOKENS

示例:
  # 1) 全命令行,DeepSeek 写一章 2500 字
  autow --base-url https://api.deepseek.com/v1 --api-key sk-xxx \\
        --model deepseek-chat --title "雾港" --words 2500

  # 2) 用配置文件 + 渲染公众号
  autow --config ./autow.config.json --title "雾港" --chapter 1 --platform wechat

  # 3) 纯环境变量(适合 CI / .env)
  AUTOW_LLM_BASE_URL=https://api.openai.com/v1 AUTOW_LLM_API_KEY=sk-xxx \\
    AUTOW_LLM_MODEL=gpt-4o-mini autow "雾港"

详见 README.md「CLI 快速上手」。
`;

function die(msg: string, code = 1): never {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(code);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function main(): void {
  // 载入 .env(若存在;Node 内置,无需 dotenv 依赖)
  try {
    process.loadEnvFile();
  } catch {
    /* 无 .env 时静默忽略 */
  }

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        title: { type: "string" },
        goal: { type: "string" },
        premise: { type: "string" },
        bible: { type: "string" },
        lang: { type: "string" },
        words: { type: "string" },
        chapter: { type: "string" },
        "book-id": { type: "string" },
        out: { type: "string" },
        platform: { type: "string" },
        "quality-threshold": { type: "string" },
        "max-revise-rounds": { type: "string" },
        provider: { type: "string" },
        "base-url": { type: "string" },
        "api-key": { type: "string" },
        model: { type: "string" },
        "fast-model": { type: "string" },
        temperature: { type: "string" },
        "max-tokens": { type: "string" },
        config: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (e) {
    die(`参数解析失败:${e instanceof Error ? e.message : String(e)}\n用 --help 查看用法。`);
  }

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const flags: CliFlags = {
    title: asString(values.title) ?? positionals[0],
    goal: asString(values.goal),
    premise: asString(values.premise),
    biblePath: asString(values.bible),
    lang: asString(values.lang),
    words: asString(values.words),
    chapter: asString(values.chapter),
    bookId: asString(values["book-id"]),
    out: asString(values.out),
    platform: asString(values.platform),
    qualityThreshold: asString(values["quality-threshold"]),
    maxReviseRounds: asString(values["max-revise-rounds"]),
    provider: asString(values.provider),
    baseUrl: asString(values["base-url"]),
    apiKey: asString(values["api-key"]),
    model: asString(values.model),
    fastModel: asString(values["fast-model"]),
    temperature: asString(values.temperature),
    maxTokens: asString(values["max-tokens"]),
    configPath: asString(values.config),
  };

  const cfg = resolveConfig(flags);

  // 启动信息(走 stderr,不污染 stdout)
  const strong = cfg.llm.strong;
  process.stderr.write(
    `◇ 引擎:provider=${strong.provider} model=${strong.model} baseUrl=${strong.baseUrl}\n`,
  );
  process.stderr.write(`◇ 作品:${cfg.title || "(未命名)"} · 第 ${cfg.chapter} 章 · 目标 ${cfg.words} 字 · ${cfg.lang}\n`);
  if (!strong.apiKey) {
    process.stderr.write(`⚠ 未提供 apiKey(--api-key / AUTOW_LLM_API_KEY),仅自部署免 key 端点可用。\n`);
  }

  const llm = createCliLlm(cfg.llm);
  const handlers = buildHandlers({ llm, qualityThreshold: cfg.qualityThreshold });

  const now = (): string => new Date().toISOString();
  const initial: RunState = {
    runId: `${cfg.bookId}:ch${cfg.chapter}`,
    bookId: cfg.bookId,
    chapterNumber: cfg.chapter,
    input: {
      platformId: cfg.platform,
      chapterTitle: cfg.title,
      chapterGoal: cfg.goal,
      bookBible: cfg.bible,
      targetWordCount: cfg.words,
      lang: cfg.lang,
    },
    stage: "planning",
    reviseRound: 0,
    artifacts: {},
    scoreHistory: [],
    startedAt: now(),
    updatedAt: now(),
  };

  const budget: StageBudget = {
    maxReviseRounds: cfg.maxReviseRounds,
    maxAttempts: 2,
    retryDelayMs: 600,
  };
  const deps: PipelineDeps = {
    handlers,
    budget,
    now,
    delay: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    onStage: (stage: WriteStage) => process.stderr.write(`▸ ${stage}\n`),
  };

  runPipeline(initial, deps, {
    onToken: (t) => process.stderr.write(t),
  })
    .then((outcome) => {
      // 提取成稿:优先 publishing.chapter;未走到签发(门禁未过)则落盘当前最优草稿。
      const pub = outcome.state.artifacts.publishing as
        | { chapter?: { title?: string; content?: string; wordCount?: number } }
        | undefined;
      let chapter = pub?.chapter;
      let usedFallback = false;
      const fallbackText = latestDraft(outcome.state.artifacts);
      if (!chapter || !chapter.content || !chapter.content.trim()) {
        chapter = {
          content: fallbackText,
          wordCount: countWords(fallbackText, cfg.lang),
        };
        usedFallback = true;
      }
      const content = (chapter.content ?? "").trim();
      const title = chapter.title?.trim() || cfg.title || `第${cfg.chapter}章`;

      if (!content) {
        die(`未生成任何正文。状态:${outcome.status}(${outcome.reason})`);
      }

      const outPath = resolve(cfg.out);
      mkdirSync(dirname(outPath), { recursive: true });
      const body = `# ${title}\n\n${content}\n`;
      writeFileSync(outPath, body, "utf8");

      // 可选:用 @autow/core 渲染成平台 HTML
      let renderedPath: string | undefined;
      if (cfg.platform) {
        try {
          const doc = markdownToContentDocument(body);
          const rendered = renderForPlatform(cfg.platform, doc);
          renderedPath = outPath.replace(/\.md$/i, "") + `.${cfg.platform}.html`;
          writeFileSync(renderedPath, rendered.html, "utf8");
        } catch (e) {
          process.stderr.write(
            `⚠ 平台渲染失败(${cfg.platform}),已跳过:${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }

      const scores = outcome.state.scoreHistory;
      process.stdout.write(`\n✓ 写作完成\n`);
      process.stdout.write(`  状态:${outcome.status}(${outcome.reason})\n`);
      process.stdout.write(`  评分历史:${scores.length ? scores.join(" → ") : "无(未触发评分阶段)"}\n`);
      process.stdout.write(`  章节标题:${title}\n`);
      process.stdout.write(`  正文字数:约 ${chapter.wordCount} 字\n`);
      process.stdout.write(`  输出文件:${outPath}\n`);
      if (renderedPath) process.stdout.write(`  平台渲染:${renderedPath}\n`);
      if (usedFallback) {
        process.stdout.write(`  ⚠ 未走到签发阶段(质量未过线或返修达上限),已落盘当前最优草稿。\n`);
      }
      process.exit(0);
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      die(`写作失败:${msg}\n  常见原因:baseURL/模型名错误、apiKey 无效、网络不通、模型不支持所需输出长度。`);
    });
}

main();
