/**
 * Scenario-driven tests for autoIngest.
 *
 * Each scenario materializes an initial project, a source document, and two
 * canned LLM responses (stage 1 analysis, stage 2 generation with FILE +
 * REVIEW blocks). The runner mocks streamChat to emit them sequentially.
 *
 * After ingest runs, the runner asserts:
 *   - expected files exist on disk with expected substrings
 *   - expected review items were injected into the review store
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"
import { materializeScenario, copyDir } from "@/test-helpers/scenarios/materialize"
import { ingestScenarios } from "@/test-helpers/scenarios/ingest-scenarios"
import type { IngestScenario } from "@/test-helpers/scenarios/types"

vi.mock("@/commands/fs", () => realFs)

// Sequenced streamChat: stage-1 returns analysisResponse, stage-2 returns
// generationResponse. Any further calls return empty (shouldn't happen in a
// typical autoIngest run).
let pendingResponses: string[] = []
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb) => {
    const resp = pendingResponses.shift() ?? ""
    cb.onToken(resp)
    cb.onDone()
  }),
}))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"

const FIXTURES_ROOT = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "scenarios-ingest",
)

beforeAll(async () => {
  await fs.rm(FIXTURES_ROOT, { recursive: true, force: true })
  await fs.mkdir(FIXTURES_ROOT, { recursive: true })
  for (const s of ingestScenarios) {
    await materializeScenario(s, FIXTURES_ROOT)
  }
})

beforeEach(() => {
  pendingResponses = []
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: IngestScenario): Promise<Ctx> {
  const tmp = await createTempProject(
    `ingest-${scenario.name.replace(/\//g, "-")}`,
  )
  const initialWikiDir = path.join(FIXTURES_ROOT, scenario.name, "initial-wiki")
  await copyDir(initialWikiDir, tmp.path)

  useWikiStore.setState({
    project: {
      name: "t",
      path: tmp.path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  // Queue up the two sequenced LLM responses
  const analysis = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-analysis.txt"),
    "utf-8",
  )
  const generation = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-generation.txt"),
    "utf-8",
  )
  pendingResponses = [analysis, generation]

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

// ── Assertions ──────────────────────────────────────────────────────────────

async function assertOutcome(
  scenario: IngestScenario,
  tmpPath: string,
): Promise<void> {
  const expected = scenario.expected

  // 1. Expected files exist
  for (const p of expected.writtenPaths) {
    const full = path.join(tmpPath, p)
    const exists = await fileExists(full)
    if (!exists) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] expected file not written: ${p}`,
      )
    }
    expect(exists, `file not written: ${p}`).toBe(true)
  }

  // 2. File contents contain expected substrings
  if (expected.fileContains) {
    for (const [relPath, substrs] of Object.entries(expected.fileContains)) {
      const full = path.join(tmpPath, relPath)
      const content = await readFileRaw(full)
      for (const sub of substrs) {
        expect(content, `${relPath} missing substring "${sub}"`).toContain(sub)
      }
    }
  }

  // 3. Review store has the expected items
  const expectedReviews = expected.reviewsCreated ?? []
  const actualReviews = useReviewStore.getState().items
  for (const e of expectedReviews) {
    const match = actualReviews.find(
      (r) => r.type === e.type && r.title.includes(e.titleContains),
    )
    if (!match) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] no review matching ${JSON.stringify(e)}. Actual:\n` +
          JSON.stringify(
            actualReviews.map((r) => ({ type: r.type, title: r.title })),
            null,
            2,
          ),
      )
    }
    expect(match, `review missing: ${JSON.stringify(e)}`).toBeTruthy()
  }

  // 4. If the scenario declared no reviews, store must be empty.
  if (expectedReviews.length === 0) {
    expect(actualReviews).toHaveLength(0)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ingest scenarios (fixture-driven)", () => {
  it.each(ingestScenarios.map((s) => [s.name, s]))(
    "%s",
    async (_name, scenario) => {
      ctx = await setup(scenario)

      const sourceFullPath = path.join(ctx.tmp.path, scenario.source.path)
      await autoIngest(
        ctx.tmp.path,
        sourceFullPath,
        useWikiStore.getState().llmConfig,
      )

      await assertOutcome(scenario, ctx.tmp.path)
    },
  )

  it("drops generated pages whose frontmatter type disagrees with schema routing", async () => {
    ctx = { tmp: await createTempProject("ingest-schema-routing") }
    const projectPath = ctx.tmp.path

    await writeFileRaw(
      `${projectPath}/schema.md`,
      [
        "# Wiki Schema",
        "",
        "## Page Types",
        "",
        "| Type | Directory | Purpose |",
        "| ---- | --------- | ------- |",
        "| source | wiki/sources/ | Source summaries |",
        "| concept | wiki/concepts/ | Ideas |",
      ].join("\n"),
    )
    await writeFileRaw(`${projectPath}/purpose.md`, "")
    await writeFileRaw(`${projectPath}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${projectPath}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${projectPath}/raw/sources/schema-routing.md`, "source\n")

    useWikiStore.setState({
      project: {
        name: "t",
        path: projectPath,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
    })
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })

    pendingResponses = [
      "analysis",
      [
        "---FILE: wiki/sources/schema-routing.md---",
        "---",
        "type: source",
        "title: Source: schema-routing.md",
        "sources: [schema-routing.md]",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Source: schema-routing.md",
        "---END FILE---",
        "",
        "---FILE: wiki/concepts/wrong-place.md---",
        "---",
        "type: source",
        "title: Wrong Place",
        "sources: [schema-routing.md]",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Wrong Place",
        "---END FILE---",
      ].join("\n"),
    ]

    const written = await autoIngest(
      projectPath,
      `${projectPath}/raw/sources/schema-routing.md`,
      useWikiStore.getState().llmConfig,
    )

    expect(written).not.toContain("wiki/concepts/wrong-place.md")
    expect(await fileExists(`${projectPath}/wiki/concepts/wrong-place.md`)).toBe(false)
  })

  it("keeps source summaries distinct for same basenames in different source folders", async () => {
    ctx = { tmp: await createTempProject("ingest-duplicate-source-basenames") }
    const projectPath = ctx.tmp.path

    await writeFileRaw(`${projectPath}/schema.md`, "")
    await writeFileRaw(`${projectPath}/purpose.md`, "")
    await writeFileRaw(`${projectPath}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${projectPath}/wiki/overview.md`, "")
    await writeFileRaw(`${projectPath}/raw/sources/project-a/config.yaml`, "name: project-a\n")
    await writeFileRaw(`${projectPath}/raw/sources/project-b/config.yaml`, "name: project-b\n")

    useWikiStore.setState({
      project: {
        name: "t",
        path: projectPath,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
    })
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })

    pendingResponses = [
      "analysis for project A",
      [
        "---FILE: wiki/sources/config.md---",
        "---",
        'type: "source"',
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Project A",
        "",
        "analysis for project A",
        "---END FILE---",
      ].join("\n"),
      "analysis for project B",
      [
        "---FILE: wiki/sources/config.md---",
        "---",
        'type: "source"',
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Project B",
        "",
        "analysis for project B",
        "---END FILE---",
      ].join("\n"),
    ]

    const cfg = useWikiStore.getState().llmConfig
    const firstWritten = await autoIngest(
      projectPath,
      `${projectPath}/raw/sources/project-a/config.yaml`,
      cfg,
    )
    const secondWritten = await autoIngest(
      projectPath,
      `${projectPath}/raw/sources/project-b/config.yaml`,
      cfg,
    )

    expect(firstWritten).toContain("wiki/sources/9-project-a--6-config--3eym4.md")
    expect(secondWritten).toContain("wiki/sources/9-project-b--6-config--177z4nx.md")
    expect(await fileExists(`${projectPath}/wiki/sources/config.md`)).toBe(false)

    const projectA = await readFileRaw(`${projectPath}/wiki/sources/9-project-a--6-config--3eym4.md`)
    const projectB = await readFileRaw(`${projectPath}/wiki/sources/9-project-b--6-config--177z4nx.md`)
    expect(projectA).toContain('sources: ["project-a/config.yaml"]')
    expect(projectA).toContain("analysis for project A")
    expect(projectB).toContain('sources: ["project-b/config.yaml"]')
    expect(projectB).toContain("analysis for project B")
  })
})

it("rejects a truncated generation before writing pages or a success cache", async () => {
  ctx = await setup(ingestScenarios[0])
  pendingResponses = [
    "A complete analysis.",
    "---FILE: wiki/sources/partial.md---\n---\ntype: source\n---\n# Partial\n---END FILE---\n---FILE: wiki/concepts/cut.md---\nAn interrupted sentence",
  ]
  await expect(autoIngest(
    ctx.tmp.path,
    path.join(ctx.tmp.path, ingestScenarios[0].source.path),
    useWikiStore.getState().llmConfig,
  )).rejects.toThrow(/incomplete|truncat/i)
  expect(await fileExists(`${ctx.tmp.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
  expect(await fileExists(`${ctx.tmp.path}/wiki/sources/partial.md`)).toBe(false)

  const debugDir = `${ctx.tmp.path}/.llm-wiki/ingest-debug`
  const dumps = await fs.readdir(debugDir)
  expect(dumps).toHaveLength(1)
  const dump = await readFileRaw(`${debugDir}/${dumps[0]}`)
  expect(dump).toContain("An interrupted sentence")
  expect(dump).toContain('FILE block "wiki/concepts/cut.md" was not closed')
})

it("does not cache a partial ingest when aggregate repair is truncated", async () => {
  ctx = await setup(ingestScenarios[0])
  pendingResponses = [
    "A complete analysis.",
    "---FILE: wiki/sources/rope-paper.md---\n---\ntype: source\ntitle: RoPE\nsources: [rope-paper.md]\n---\n# RoPE\nA complete source summary.\n---END FILE---",
    "---FILE: wiki/index.md---\n# Index\nAn interrupted entry",
  ]
  await expect(autoIngest(
    ctx.tmp.path,
    path.join(ctx.tmp.path, ingestScenarios[0].source.path),
    useWikiStore.getState().llmConfig,
  )).rejects.toThrow(/incomplete/i)
  expect(await fileExists(`${ctx.tmp.path}/.llm-wiki/ingest-cache.json`)).toBe(false)
})

it("merges index entries into the existing index and leaves overview untouched", async () => {
  ctx = { tmp: await createTempProject("ingest-index-merge") }
  const projectPath = ctx.tmp.path
  const existingIndex = [
    "# Wiki Index",
    "",
    "## Concepts",
    "",
    "### 도어",
    "",
    "- [[슬라이딩-도어]] — 기존 항목",
    "",
  ].join("\n")
  const existingOverview = "# Overview\n\n기존 개요 문단.\n"
  await writeFileRaw(`${projectPath}/schema.md`, "")
  await writeFileRaw(`${projectPath}/purpose.md`, "")
  await writeFileRaw(`${projectPath}/wiki/index.md`, existingIndex)
  await writeFileRaw(`${projectPath}/wiki/overview.md`, existingOverview)
  await writeFileRaw(`${projectPath}/raw/sources/door.md`, "포켓 도어 설명\n")

  useWikiStore.setState({
    project: {
      name: "t",
      path: projectPath,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  pendingResponses = [
    "analysis",
    [
      "---FILE: wiki/sources/door.md---",
      "---",
      "type: source",
      "title: \"Source: door.md\"",
      "sources: [door.md]",
      "tags: []",
      "related: []",
      "---",
      "",
      "# Source: door.md",
      "---END FILE---",
      "",
      "---FILE: wiki/index.md---",
      "## Concepts",
      "### 도어",
      "- [[포켓-도어]] — 새 항목",
      "- [[슬라이딩-도어]] — 중복이라 무시",
      "---END FILE---",
      "",
      "---FILE: wiki/log.md---",
      "## [2026-11-20] ingest | door",
      "---END FILE---",
      "",
      "---FILE: wiki/overview.md---",
      "# Overview",
      "",
      "모델이 새로 쓴 개요.",
      "---END FILE---",
    ].join("\n"),
  ]

  await autoIngest(projectPath, `${projectPath}/raw/sources/door.md`, useWikiStore.getState().llmConfig)

  const index = await readFileRaw(`${projectPath}/wiki/index.md`)
  expect(index).toContain("- [[슬라이딩-도어]] — 기존 항목")
  expect(index).toContain("- [[포켓-도어]] — 새 항목")
  expect(index).not.toContain("중복이라 무시")
  expect(index.indexOf("[[포켓-도어]]")).toBeGreaterThan(index.indexOf("[[슬라이딩-도어]]"))
  expect(await readFileRaw(`${projectPath}/wiki/overview.md`)).toBe(existingOverview)
  expect(pendingResponses).toHaveLength(0)
})

it("gives the analysis stage enough output budget for a Korean analysis", async () => {
  const { streamChat } = await import("./llm-client")
  const mocked = vi.mocked(streamChat)
  mocked.mockClear()
  ctx = await setup(ingestScenarios[0])
  pendingResponses = ["analysis", ""]
  await autoIngest(
    ctx.tmp.path,
    path.join(ctx.tmp.path, ingestScenarios[0].source.path),
    useWikiStore.getState().llmConfig,
  ).catch(() => undefined)
  const analysisOverrides = mocked.mock.calls[0]?.[4] as { max_tokens?: number } | undefined
  expect(analysisOverrides?.max_tokens).toBe(16_384)
})
