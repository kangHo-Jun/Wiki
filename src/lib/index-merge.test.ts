import { describe, it, expect } from "vitest"
import { mergeIndexEntries } from "./index-merge"

const EXISTING = [
  "---",
  "type: index",
  "title: Wiki Index",
  "---",
  "",
  "# Wiki Index",
  "",
  "## Entities",
  "",
  "### 도어 자재",
  "",
  "- [[슬라이딩-도어]] — 레일 위를 움직이는 문",
  "- [[여닫이-도어]] — 경첩으로 여는 문",
  "",
  "### 합판 자재",
  "",
  "- [[미송합판]] — 미송 단판 합판",
  "",
  "## Concepts",
  "",
  "### 도어 시공",
  "",
  "- [[문틀-수평]] — 문틀 수평 맞추기",
  "",
].join("\n")

describe("mergeIndexEntries", () => {
  it("inserts a new entry at the end of the matching ### section", () => {
    const incoming = [
      "## Entities",
      "### 도어 자재",
      "- [[포켓-도어]] — 벽 속으로 들어가는 문",
    ].join("\n")

    const { content, added } = mergeIndexEntries(EXISTING, incoming)

    expect(added).toEqual(["- [[포켓-도어]] — 벽 속으로 들어가는 문"])
    const lines = content.split("\n")
    const pocket = lines.indexOf("- [[포켓-도어]] — 벽 속으로 들어가는 문")
    expect(lines[pocket - 1]).toBe("- [[여닫이-도어]] — 경첩으로 여는 문")
    expect(lines.indexOf("### 합판 자재")).toBeGreaterThan(pocket)
  })

  it("skips entries whose wikilink target already exists anywhere in the index", () => {
    const incoming = [
      "## Concepts",
      "### 도어 시공",
      "- [[슬라이딩-도어]] — 다른 설명",
      "- [[문틀-수평]] — 중복",
    ].join("\n")

    const { content, added } = mergeIndexEntries(EXISTING, incoming)

    expect(added).toEqual([])
    expect(content).toBe(EXISTING)
  })

  it("creates a missing ### section at the end of its ## section", () => {
    const incoming = [
      "## Entities",
      "### 도어 하드웨어",
      "- [[댐퍼]] — 문 닫힘 속도 조절",
    ].join("\n")

    const { content } = mergeIndexEntries(EXISTING, incoming)
    const lines = content.split("\n")
    const heading = lines.indexOf("### 도어 하드웨어")

    expect(heading).toBeGreaterThan(lines.indexOf("- [[미송합판]] — 미송 단판 합판"))
    expect(heading).toBeLessThan(lines.indexOf("## Concepts"))
    expect(lines.slice(heading, heading + 3)).toEqual(["### 도어 하드웨어", "", "- [[댐퍼]] — 문 닫힘 속도 조절"])
  })

  it("appends a missing ## section at the end of the file", () => {
    const incoming = ["## Sources", "- [[도어조사-11차]] — 11차 조사 요약"].join("\n")

    const { content } = mergeIndexEntries(EXISTING, incoming)

    expect(content.trimEnd().endsWith("## Sources\n\n- [[도어조사-11차]] — 11차 조사 요약")).toBe(true)
  })

  it("appends headingless entries at the end of the file", () => {
    const { content, added } = mergeIndexEntries(EXISTING, "- [[새-개념]] — 설명")

    expect(added).toHaveLength(1)
    expect(content.trimEnd().endsWith("- [[새-개념]] — 설명")).toBe(true)
  })

  it("keeps the existing index unchanged when the model echoes the whole index", () => {
    const { content, added } = mergeIndexEntries(EXISTING, EXISTING)

    expect(added).toEqual([])
    expect(content).toBe(EXISTING)
  })

  it("uses the incoming entries as the index when none exists yet", () => {
    const incoming = "## Concepts\n\n- [[a]] — b\n"
    expect(mergeIndexEntries("", incoming).content).toBe(incoming)
  })

  it("does not add the same new entry twice within one response", () => {
    const incoming = ["### 도어 자재", "- [[포켓-도어]] — a", "- [[포켓-도어]] — b"].join("\n")
    expect(mergeIndexEntries(EXISTING, incoming).added).toHaveLength(1)
  })
})
