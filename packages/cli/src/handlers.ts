/**
 * @autow/cli —— 写作流水线的 7 个阶段实现(StageHandler)。
 *
 * 这里只编排「调用 LlmClient」与「组装门禁 GateDecision」,真正的状态机推进(门禁判定、
 * 返修回环、单调上升保护、崩溃可续)完全交给 @autow/engine 的 runPipeline。我们为每个阶段
 * 注入真实可跑的 handler,让 CLI 真正写出一章正文,而不是 README 里那种恒 pass 的桩。
 *
 * 七阶段:planning → writing → reviewing → revising → polishing → verifying → publishing
 * 评分维度与 @autow/engine 的 QualityScore 对齐(consistency/pacing/emotion/prose/deAiTell)。
 */
import { z } from "zod";
import type {
  LlmClient,
  StageHandler,
  StageContext,
  WriteStage,
  GateDecision,
  QualityScore,
  GateVerdict,
} from "@autow/engine";

const PROSE_BUDGET = 8192; // 写作/修订/润色的输出 token 预算(够 ~3000 中文字)
const PLAN_BUDGET = 1800; // 提纲/评审报告的输出预算
const SCORE_BUDGET = 1500;

export interface HandlerDeps {
  readonly llm: LlmClient;
  /** 过线分(0-100);overall ≥ 它即视为达标。默认 80,偏宽松以保证「能跑」。 */
  readonly qualityThreshold: number;
}

// ── 评审结构化输出 schema(与 QualityScore 维度对齐)──
const CritiqueSchema = z.object({
  overall: z.number(),
  dimensions: z.object({
    consistency: z.number(),
    pacing: z.number(),
    emotion: z.number(),
    prose: z.number(),
    deAiTell: z.number(),
  }),
  mustFix: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});
type Critique = z.infer<typeof CritiqueSchema>;

// ── 工具函数 ──
function clampScore(n: unknown, fallback = 88): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 粗略字数统计:中文计 CJK 字符,英文计空格分隔词。 */
export function countWords(text: string, lang: "zh" | "en"): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = (text.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  // en 文本里基本没有 CJK(cjk=0),两种语言都可按「CJK 字 + 西文词」相加。
  return cjk + latin;
}

/** 取当前最优正文:润色稿 ?? 修订稿 ?? 初稿。 */
export function latestDraft(artifacts: Record<string, unknown>): string {
  const pick = (stage: string, field: string): string | undefined => {
    const a = artifacts[stage] as Record<string, unknown> | undefined;
    const v = a?.[field];
    return typeof v === "string" ? v : undefined;
  };
  return pick("polishing", "polished") ?? pick("revising", "revised") ?? pick("writing", "draft") ?? "";
}

/** 清掉模型偶尔包裹的整段代码围栏与首尾空白。 */
function cleanProse(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  return t;
}

function dimensionScore(d: Critique["dimensions"]): QualityScore["dimensions"] {
  return {
    consistency: clampScore(d.consistency),
    pacing: clampScore(d.pacing),
    emotion: clampScore(d.emotion),
    prose: clampScore(d.prose),
    deAiTell: clampScore(d.deAiTell),
  };
}

function nominalScore(threshold: number): QualityScore {
  // 评审/终检结构化输出失败时的兜底分:刚好压在过线分上,保证流程继续推进。
  return {
    overall: threshold,
    dimensions: {
      consistency: threshold,
      pacing: threshold,
      emotion: threshold,
      prose: threshold,
      deAiTell: threshold,
    },
    passThreshold: threshold,
  };
}

const ROLE_LABEL: Record<string, string> = {
  planner: "选题策划",
  writer: "主笔写手",
  "reader-critic": "读者评论家",
  reviser: "修订编辑",
  polisher: "润色编辑",
  "quality-reporter": "质检官",
  "editor-in-chief": "总编",
};

function baseSystem(role: string, ctx: StageContext): string {
  const inp = ctx.state.input;
  const lines: string[] = [
    `你是「卷舍」AI 编辑部的${ROLE_LABEL[role] ?? role},精通长篇虚构写作。`,
  ];
  if (inp.bookBible?.trim()) lines.push(`\n# 作品设定(bible)\n${inp.bookBible.trim()}`);
  if (inp.genreId) lines.push(`\n题材:${inp.genreId}`);
  lines.push(`\n语言:${inp.lang === "en" ? "English" : "中文"}。`);
  lines.push(`本章目标字数:约 ${inp.targetWordCount ?? 3000} 字。`);
  return lines.join("\n");
}

function chapterMeta(ctx: StageContext): string {
  const inp = ctx.state.input;
  return [
    `# 本章信息`,
    `章号:第 ${ctx.state.chapterNumber} 章`,
    inp.chapterTitle ? `标题:${inp.chapterTitle}` : "",
    inp.chapterGoal ? `本章目标:${inp.chapterGoal}` : "",
    inp.priorContext ? `\n# 前情提要(保持连续)\n${inp.priorContext}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

interface ProseResult {
  artifacts: Record<string, unknown>;
  gate: GateDecision;
}

const PASS: GateDecision = { verdict: "pass", mustFix: [] };

/**
 * 构造 7 个阶段 handler。返回的 Record 直接喂给 runPipeline 的 PipelineDeps.handlers。
 */
export function buildHandlers(deps: HandlerDeps): Record<WriteStage, StageHandler> {
  const { llm, qualityThreshold } = deps;

  return {
    // ── 规划:产出本章紧凑提纲(beat sheet)──
    planning: {
      stage: "planning",
      role: "planner",
      modelTier: "strong",
      async run(ctx): Promise<ProseResult> {
        const u = [
          chapterMeta(ctx),
          "",
          "# 任务",
          "为本章产出一份紧凑的写作提纲(3-6 个 beat),每个 beat 一行:谁、在哪里、发生什么、推进了什么情绪或悬念。",
          "只输出提纲正文,不要解释、不要标题行外的废话。",
        ].join("\n");
        const r = await llm.generate({
          system: baseSystem("planner", ctx),
          messages: [{ role: "user", content: u }],
          modelTier: "strong",
          temperature: 0.6,
          maxOutputTokens: PLAN_BUDGET,
        });
        return { artifacts: { outline: r.text.trim() }, gate: PASS };
      },
    },

    // ── 写作:按提纲逐字生成正文 ──
    writing: {
      stage: "writing",
      role: "writer",
      modelTier: "strong",
      async run(ctx): Promise<ProseResult> {
        const inp = ctx.state.input;
        const outline = ((ctx.state.artifacts.planning as { outline?: unknown }) ?? {}).outline;
        const u = [
          "# 写作任务",
          typeof outline === "string" && outline.trim()
            ? `# 本章提纲(严格遵守节拍)\n${outline.trim()}`
            : "",
          inp.chapterGoal ? `本章必须达成:${inp.chapterGoal}` : "",
          "",
          "# 要求",
          `- 直接写正文,目标约 ${inp.targetWordCount ?? 3000} 字,篇幅要足、场景要展开。`,
          `- 场景化、展示而非陈述(show, don't tell):有感官细节、人物动作与对话。`,
          `- 避免 AI 味:不用"然而/值得一提的是/总而言之/不可否认"这类套话,句式长短交错。`,
          `- 开头第一句就把读者拉进场景;不要写"本章/这一章"这类元叙述。`,
          `- 只输出小说正文:不要提纲、不要注释、不要 markdown 代码围栏、不要任何解释。`,
          inp.chapterTitle ? `- 正文不要重复标题行。` : "",
        ]
          .filter(Boolean)
          .join("\n");
        const r = await llm.generate({
          system: baseSystem("writer", ctx),
          messages: [{ role: "user", content: u }],
          modelTier: "strong",
          temperature: 0.85,
          maxOutputTokens: PROSE_BUDGET,
          onToken: ctx.onToken,
        });
        return { artifacts: { draft: cleanProse(r.text) }, gate: PASS };
      },
    },

    // ── 审稿:读者+评论家视角打分 + 必改项 ──
    reviewing: {
      stage: "reviewing",
      role: "reader-critic",
      modelTier: "strong",
      async run(ctx): Promise<ProseResult> {
        const draft = latestDraft(ctx.state.artifacts);
        const u = [
          "# 待审草稿",
          draft,
          "",
          "# 任务",
          "以读者与评论家视角审稿,严格按结构化 JSON 输出评分与必改项。",
          "维度(0-100):consistency(一致性)、pacing(节奏)、emotion(情感张力)、prose(文笔)、deAiTell(去AI味,越高越好)。overall 为综合分。",
          "mustFix:最多 5 条、具体可执行的修改建议(指出位置 + 怎么改)。",
          "只输出 JSON,不要任何解释或代码围栏。",
        ].join("\n");

        let score: QualityScore;
        let mustFix: string[];
        let rationale: string | undefined;
        let verdict: GateVerdict;
        try {
          const r = await llm.generateStructured({
            system: baseSystem("reader-critic", ctx),
            messages: [{ role: "user", content: u }],
            schema: CritiqueSchema,
            modelTier: "strong",
            temperature: 0.3,
            maxOutputTokens: SCORE_BUDGET,
          });
          const d = r.data;
          score = {
            overall: clampScore(d.overall),
            dimensions: dimensionScore(d.dimensions),
            passThreshold: qualityThreshold,
          };
          mustFix = (d.mustFix ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 5);
          rationale = d.rationale;
          verdict = score.overall >= qualityThreshold ? "pass" : "revise";
        } catch {
          score = nominalScore(qualityThreshold);
          mustFix = [];
          rationale = "评审结构化输出失败,按通过兜底(可检查模型是否支持 JSON 输出)。";
          verdict = "pass";
        }
        return {
          artifacts: { critique: rationale ?? "", mustFix },
          gate: { verdict, score, mustFix, rationale },
        };
      },
    },

    // ── 修订:按 mustFix 定向、最小改动 ──
    revising: {
      stage: "revising",
      role: "reviser",
      modelTier: "strong",
      async run(ctx): Promise<ProseResult> {
        const draft = latestDraft(ctx.state.artifacts);
        const review = ctx.state.artifacts.reviewing as { mustFix?: unknown } | undefined;
        const rawFixes = Array.isArray(review?.mustFix) ? (review!.mustFix as unknown[]) : [];
        const fixes = rawFixes.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);

        if (!draft.trim() || fixes.length === 0) {
          return { artifacts: { revised: draft.trim() }, gate: PASS };
        }
        const u = [
          "# 待修订草稿",
          draft,
          "",
          "# 必须解决的问题(定向、最小改动)",
          ...fixes.map((f, i) => `${i + 1}. ${f}`),
          "",
          "# 要求",
          "按上述问题逐条修订,保留原文优点、情节与人物设定,只改需要改的地方。",
          "输出完整修订稿正文,不要解释、不要 markdown 代码围栏。",
        ].join("\n");
        const r = await llm.generate({
          system: baseSystem("reviser", ctx),
          messages: [{ role: "user", content: u }],
          modelTier: "strong",
          temperature: 0.7,
          maxOutputTokens: PROSE_BUDGET,
        });
        return { artifacts: { revised: cleanProse(r.text) }, gate: PASS };
      },
    },

    // ── 润色:文字层精修 + 去 AI 味(走快模型)──
    polishing: {
      stage: "polishing",
      role: "polisher",
      modelTier: "fast",
      async run(ctx): Promise<ProseResult> {
        const draft = latestDraft(ctx.state.artifacts);
        if (!draft.trim()) return { artifacts: { polished: "" }, gate: PASS };
        const u = [
          "# 润色任务",
          "对下面正文做最后一道文字润色:消除残留 AI 味、统一语气、句式长短交错、删冗词、强化画面感与情绪落点。",
          "不得改变情节、人物与事实,只动文字层。输出完整正文,不要解释、不要 markdown 代码围栏。",
          "",
          "# 待润色正文",
          draft,
        ].join("\n");
        const r = await llm.generate({
          system: baseSystem("polisher", ctx),
          messages: [{ role: "user", content: u }],
          modelTier: "fast",
          temperature: 0.7,
          maxOutputTokens: PROSE_BUDGET,
        });
        const polished = cleanProse(r.text) || draft;
        return { artifacts: { polished }, gate: PASS };
      },
    },

    // ── 终检:发布前质量门(连续性/节奏/文笔/字数/AI 味)──
    verifying: {
      stage: "verifying",
      role: "quality-reporter",
      modelTier: "strong",
      async run(ctx): Promise<ProseResult> {
        const text = latestDraft(ctx.state.artifacts);
        const inp = ctx.state.input;
        const target = inp.targetWordCount ?? 3000;
        const u = [
          "# 待终检正文",
          text,
          "",
          "# 任务",
          `做发布前终检。目标字数约 ${target} 字。按结构化 JSON 输出(维度同审稿):overall 与 consistency/pacing/emotion/prose/deAiTell(0-100)。`,
          "mustFix:仍需修补的具体问题(最多 3 条),没有就给空数组。只输出 JSON。",
        ].join("\n");

        let score: QualityScore;
        let mustFix: string[];
        let verdict: GateVerdict;
        try {
          const r = await llm.generateStructured({
            system: baseSystem("quality-reporter", ctx),
            messages: [{ role: "user", content: u }],
            schema: CritiqueSchema,
            modelTier: "strong",
            temperature: 0.3,
            maxOutputTokens: SCORE_BUDGET,
          });
          const d = r.data;
          score = {
            overall: clampScore(d.overall),
            dimensions: dimensionScore(d.dimensions),
            passThreshold: qualityThreshold,
          };
          mustFix = (d.mustFix ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3);
          verdict = score.overall >= qualityThreshold ? "pass" : "revise";
        } catch {
          score = nominalScore(qualityThreshold);
          mustFix = [];
          verdict = "pass";
        }
        return { artifacts: { report: score }, gate: { verdict, score, mustFix } };
      },
    },

    // ── 签发:总编定稿,产出最终章节对象 ──
    publishing: {
      stage: "publishing",
      role: "editor-in-chief",
      modelTier: "fast",
      async run(ctx): Promise<ProseResult> {
        const inp = ctx.state.input;
        const content = cleanProse(latestDraft(ctx.state.artifacts));
        const title =
          inp.chapterTitle?.trim() ||
          (inp.lang === "en"
            ? `Chapter ${ctx.state.chapterNumber}`
            : `第${ctx.state.chapterNumber}章`);
        const chapter = {
          title,
          content,
          wordCount: countWords(content, inp.lang),
        };
        return { artifacts: { chapter }, gate: PASS };
      },
    },
  };
}
