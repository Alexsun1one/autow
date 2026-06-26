# autow

autow 是从卷舍商业 monorepo 中抽出的开源写作引擎内核，只包含写作流水线、编辑部智能体、LLM 适配层、知识结构化、内容渲染与质量门相关代码。不包含桌面应用、SaaS、计费、激活、商业后台或发布流水线。

本仓库当前形态是纯引擎库 + README：

- `@autow/core`：写作引擎核心逻辑，包含 agents、pipeline、editorial、knowledge、content、state、models、skills、质量门和平台内容渲染等模块。
- `@autow/engine`：更薄的一层写作状态机、运行驱动、LLM 客户端接口和 AI SDK 适配。

## 架构概览

`packages/core/src` 是主要业务内核：

- `agents/`：规划、架构、写手、审稿、修订、润色、连续性检查等编辑部角色。
- `pipeline/`：章节写作流水线、阶段追踪、治理策略、复读账本和调度器。
- `editorial/`：文章生成后的评审、修订、研究上下文与账号风格演化。
- `knowledge/`：角色矩阵、情感弧线、伏笔板、卷纲、章节摘要等 Markdown 结构化解析。
- `llm/`：模型服务、provider 解析、错误翻译、服务预设与运行时环境处理。
- `content/` 和 `platforms/`：Markdown 到内容 AST，再渲染到公众号、知乎、小红书、X、newsletter 等平台。
- `state/` 和 `models/`：项目、作品、章节、运行时状态、输入治理和本地状态管理。
- `skills/`：编辑部技能注册与加载。

`packages/engine/src` 提供更底层的可替换运行时：

- `orchestration/`：显式状态机、阶段门禁和 `runPipeline` 驱动。
- `llm/`：provider 无关的 `LlmClient` 接口，以及基于 Vercel AI SDK 的适配层。
- `quality/`、`memory/`、`knowledge/`、`style/`：质量评估、记忆、知识包与风格学习的基础模块。

## 安装

本地开发：

```bash
pnpm install
pnpm -r build
```

作为 workspace 依赖使用：

```json
{
  "dependencies": {
    "@autow/core": "workspace:*",
    "@autow/engine": "workspace:*"
  }
}
```

## 命令行快速上手（CLI）

不想写代码？装好依赖后，`@autow/cli` 让你一条命令写出一章——自带 LLM key 即可（BYOK）：

```bash
pnpm install && pnpm -r build

# 用任意 OpenAI 兼容端点写一章（以 DeepSeek 为例）
node packages/cli/dist/index.js 《雾港旧事》 \
  --base-url https://api.deepseek.com/v1 \
  --api-key sk-xxxxx \
  --model deepseek-chat \
  --words 3000 \
  --out out/chapter-1.md
```

成稿落到 `out/chapter-1.md`。引擎跑完七阶段流水线（规划 → 写作 → 审稿 → 修订 → 润色 → 校验 → 出版），由质量门禁判定是否返修。

常用参数：

| 参数 | 说明 |
|---|---|
| `《书名》` / `--title` | 章节/作品标题 |
| `--premise` / `--bible <path>` | 作品设定（一句话主题，或详尽设定文件） |
| `--goal` | 本章目标/节拍 |
| `--words` | 目标字数（默认 3000） |
| `--model` | 强模型（规划/写作/审稿/修订/判官）**必填** |
| `--fast-model` | 快模型（润色，缺省回落到 `--model`） |
| `--base-url` / `--api-key` | OpenAI 兼容端点 + key（BYOK） |
| `--platform` | 额外渲染成平台 HTML：`wechat` / `zhihu` / `xiaohongshu` / `x` / `newsletter` |
| `--quality-threshold` | 过线分 0-100（默认 80） |
| `--max-revise-rounds` | 返修上限（默认 1） |

配置优先级：命令行 `>` 环境变量（`AUTOW_LLM_*`）`>` `autow.config.json` `>` 内置默认。完整参数见 `autow --help`。

## 用法示例

下面的示例只使用 `packages/core/src/index.ts` 和 `packages/engine/src/index.ts` 已真实导出的 API。

第一段展示如何用 `@autow/engine` 跑显式写作状态机。引擎不会替你编造一套隐藏的“一键写书”接口；你需要为每个阶段注入 `StageHandler`，handler 内部可以接自己的 LLM、文件系统或业务存储。

```ts
import {
  runPipeline,
  type RunState,
  type StageBudget,
  type StageHandler,
  type WriteStage,
} from "@autow/engine";

const now = () => new Date().toISOString();

const stages = [
  "planning",
  "writing",
  "reviewing",
  "revising",
  "polishing",
  "verifying",
  "publishing",
] as const satisfies readonly WriteStage[];

const roles = {
  planning: "planner",
  writing: "writer",
  reviewing: "reader-critic",
  revising: "reviser",
  polishing: "polisher",
  verifying: "quality-reporter",
  publishing: "editor-in-chief",
} as const;

const passGate = {
  verdict: "pass" as const,
  mustFix: [],
  score: {
    overall: 88,
    dimensions: {
      consistency: 88,
      pacing: 86,
      emotion: 87,
      prose: 90,
      deAiTell: 89,
    },
    passThreshold: 85,
  },
};

const handlers = Object.fromEntries(
  stages.map((stage) => [
    stage,
    {
      stage,
      role: roles[stage],
      modelTier: stage === "reviewing" ? "strong" : "fast",
      async run(ctx) {
        return {
          artifacts: {
            note: `${stage} finished for chapter ${ctx.state.chapterNumber}`,
          },
          gate: passGate,
        };
      },
    } satisfies StageHandler,
  ]),
) as Record<WriteStage, StageHandler>;

const initial: RunState = {
  runId: "run-local-001",
  bookId: "demo-book",
  chapterNumber: 1,
  input: {
    chapterTitle: "第一章",
    chapterGoal: "建立主角处境和第一个悬念",
    targetWordCount: 3000,
    lang: "zh",
  },
  stage: "planning",
  reviseRound: 0,
  artifacts: {},
  scoreHistory: [],
  startedAt: now(),
  updatedAt: now(),
};

const budget: StageBudget = {
  maxReviseRounds: 2,
  maxAttempts: 1,
  retryDelayMs: 0,
};

const result = await runPipeline(initial, {
  handlers,
  budget,
  now,
  delay: async () => undefined,
  persist: async (state) => {
    // 在这里保存快照，支持崩溃恢复或审计。
    console.log("checkpoint", state.stage);
  },
});

console.log(result.status, result.reason);
```

第二段展示 `@autow/core` 的内容 AST、平台渲染和评审解析能力：

```ts
import {
  markdownToContentDocument,
  renderForPlatform,
  parseCritiqueReport,
  critiquePasses,
} from "@autow/core";

const doc = markdownToContentDocument(
  `# 为什么写作引擎需要质量门

## 核心判断
质量门不是为了阻止写作，而是为了把问题定位到可修的地方。

- 结构是否成立
- 角色动机是否连续
- 文风是否偏离设定`,
  { tone: "knowledge" },
);

const wechat = renderForPlatform("wechat", doc);
console.log(wechat.html);

const report = parseCritiqueReport(
  JSON.stringify({
    overall: "结构清楚，但例子还可以更具体。",
    score: 87,
    issues: [
      {
        severity: "minor",
        where: "第二段",
        problem: "读者还不知道质量门具体怎么落地。",
        fix: "补一个章节修订前后的对比。",
      },
    ],
  }),
);

console.log(critiquePasses(report)); // true
```

## License

本仓库使用 AGPL-3.0-or-later。

你可以自由使用、复制、修改和分发本项目；如果你发布修改版，或把修改版作为网络服务提供给用户使用，需要按 AGPL 要求向这些用户提供同样许可证下的对应源代码。AGPL 的网络服务条款意味着：不能把修改后的服务端版本闭源托管给公众使用。

完整条款见 [LICENSE](./LICENSE)。
