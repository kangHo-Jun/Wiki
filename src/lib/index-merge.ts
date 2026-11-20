/**
 * Append-only merge for wiki/index.md.
 *
 * Ingest used to ask the model to re-emit the complete index on every
 * source. Once the index grew past ~20K tokens that alone exhausted the
 * generation output budget (Gemini finishReason=MAX_TOKENS), so every
 * ingest failed. The model now emits only the NEW entries, grouped under
 * `## Section` / `### Subsection` headings, and this function places them
 * into the existing index deterministically.
 *
 * Rules:
 * - A bullet whose `[[target]]` already appears anywhere in the index is
 *   skipped (so an echoed full index is a no-op).
 * - New bullets go after the last line of the matching `###` section,
 *   creating the `###` (inside its `##`) or the `##` section when missing.
 * - Bullets with no heading context are appended at the end of the file.
 */

export interface IndexMergeResult {
  content: string
  added: string[]
}

interface PendingEntry {
  h2: string | null
  h3: string | null
  line: string
}

const BULLET_RE = /^\s*[-*]\s+\S/
const H2_RE = /^##\s+(.+?)\s*$/
const H3_RE = /^###\s+(.+?)\s*$/

function normHeading(text: string): string {
  return text.trim().replace(/[:：]\s*$/, "").toLowerCase()
}

function entryKey(line: string): string {
  const link = line.match(/\[\[([^\]|#]+)/)
  if (link) return `link:${link[1].trim().toLowerCase()}`
  return `line:${line.trim().replace(/\s+/g, " ").toLowerCase()}`
}

function collectKeys(lines: string[]): Set<string> {
  const keys = new Set<string>()
  for (const line of lines) {
    for (const m of line.matchAll(/\[\[([^\]|#]+)/g)) keys.add(`link:${m[1].trim().toLowerCase()}`)
    if (BULLET_RE.test(line)) keys.add(entryKey(line))
  }
  return keys
}

function parseIncoming(incoming: string): PendingEntry[] {
  const lines = incoming.replace(/\r\n/g, "\n").split("\n")
  let start = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1)
    if (end > 0) start = end + 1
  }
  const entries: PendingEntry[] = []
  let h2: string | null = null
  let h3: string | null = null
  for (const line of lines.slice(start)) {
    const m2 = line.match(H2_RE)
    if (m2 && !line.startsWith("###")) {
      h2 = m2[1]
      h3 = null
      continue
    }
    const m3 = line.match(H3_RE)
    if (m3) {
      h3 = m3[1]
      continue
    }
    if (BULLET_RE.test(line)) entries.push({ h2, h3, line: line.trimEnd() })
  }
  return entries
}

function headingLevel(line: string): number {
  const m = line.match(/^(#{1,6})\s/)
  return m ? m[1].length : 0
}

/** End (exclusive) of the section that starts at `start` with heading `level`. */
function sectionEnd(lines: string[], start: number, level: number, limit: number): number {
  for (let i = start + 1; i < limit; i++) {
    const lv = headingLevel(lines[i])
    if (lv > 0 && lv <= level) return i
  }
  return limit
}

function findHeading(lines: string[], level: number, name: string, from: number, to: number): number {
  const prefix = "#".repeat(level) + " "
  const want = normHeading(name)
  for (let i = from; i < to; i++) {
    if (headingLevel(lines[i]) === level && normHeading(lines[i].slice(prefix.length)) === want) return i
  }
  return -1
}

/** Index just after the last non-blank line in [from, to). */
function afterLastContent(lines: string[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) {
    if (lines[i].trim() !== "") return i + 1
  }
  return from
}

function insertEntry(lines: string[], entry: PendingEntry): void {
  const total = lines.length
  let rangeStart = 0
  let rangeEnd = total

  if (entry.h2) {
    const h2At = findHeading(lines, 2, entry.h2, 0, total)
    if (h2At < 0) {
      const at = afterLastContent(lines, 0, total)
      const block = ["", `## ${entry.h2}`, ""]
      if (entry.h3) block.push(`### ${entry.h3}`, "")
      block.push(entry.line)
      lines.splice(at, total - at, ...block, "")
      return
    }
    rangeStart = h2At
    rangeEnd = sectionEnd(lines, h2At, 2, total)
  }

  if (entry.h3) {
    const h3At = findHeading(lines, 3, entry.h3, rangeStart, rangeEnd)
    if (h3At >= 0) {
      const end = sectionEnd(lines, h3At, 3, rangeEnd)
      lines.splice(afterLastContent(lines, h3At, end), 0, entry.line)
      return
    }
    const at = afterLastContent(lines, rangeStart, rangeEnd)
    lines.splice(at, 0, "", `### ${entry.h3}`, "", entry.line)
    return
  }

  if (entry.h2) {
    lines.splice(afterLastContent(lines, rangeStart, rangeEnd), 0, entry.line)
    return
  }

  const at = afterLastContent(lines, 0, total)
  lines.splice(at, total - at, entry.line, "")
}

export function mergeIndexEntries(existing: string, incoming: string): IndexMergeResult {
  if (!existing.trim()) {
    return { content: incoming, added: parseIncoming(incoming).map((e) => e.line) }
  }

  const lines = existing.split("\n")
  const seen = collectKeys(lines)
  const added: string[] = []
  for (const entry of parseIncoming(incoming)) {
    const key = entryKey(entry.line)
    if (seen.has(key)) continue
    seen.add(key)
    insertEntry(lines, entry)
    added.push(entry.line)
  }
  if (added.length === 0) return { content: existing, added }
  return { content: lines.join("\n"), added }
}
