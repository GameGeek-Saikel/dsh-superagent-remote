/**
 * Parser for the Markdown the conversation renders.
 *
 * Agent replies arrive as GitHub issue comments, so the subset is GitHub
 * Flavored Markdown: headings, paragraphs, lists, fenced code, block quotes,
 * pipe tables, rules, and the inline runs they contain. Raw HTML stays text —
 * every node renders through React, which escapes it.
 *
 * Two choices follow GitHub rather than CommonMark: a line break inside a
 * paragraph stays a line break, and a fence inside a list item remains text.
 *
 * The parser is pure, so tests/markdown.spec.ts covers it without React.
 */

/** Horizontal alignment of one table column, from its delimiter row. */
export type Align = 'start' | 'center' | 'end'

/** One run of inline Markdown. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; url: string; children: Inline[] }

/** One list item: its own lines, then whatever nests under it. */
export interface ListItem {
  /** Inline runs of one visual line; a soft break inside the item adds another. */
  lines: Inline[][]
  /** Blocks that belong to the item, which is where deeper lists land. */
  blocks: Block[]
}

/** One block of the document. */
export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }

/** Only these schemes become links; anything else stays text. */
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i
/** Emphasis nests at most this far; deeper markers stay literal. */
const MAX_DEPTH = 4
/** Characters that can start an inline run; everything else is copied as text. */
const SPECIAL = '`*_~[<hH\\'
/** A fence opening: three or more backticks or tildes, then an optional info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/
/** ASCII punctuation a backslash may escape. */
const ESCAPABLE = /[!-/:-@[-`{-~]/
/** A list item: its indent, its marker, and its text. */
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

/**
 * Parse one line of inline Markdown.
 * @param source - the line, without its line break.
 * @param depth - nesting level, which stops runaway emphasis.
 * @returns the inline runs in order, with adjacent text merged.
 */
export function parseInline(source: string, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return [{ kind: 'text', text: source }]
  const out: Inline[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.length > 0) {
      out.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }
  let index = 0
  while (index < source.length) {
    const at = nextSpecial(source, index)
    if (at > index) {
      buffer += source.slice(index, at)
      index = at
      continue
    }
    const rest = source.slice(index)
    if (rest[0] === '\\' && ESCAPABLE.test(rest[1] ?? '')) {
      buffer += rest[1]
      index += 2
      continue
    }
    const code = /^(`+)([\s\S]*?)\1/.exec(rest)
    if (code !== null && (code[2] ?? '').length > 0) {
      flush()
      out.push({ kind: 'code', text: (code[2] ?? '').trim() })
      index += code[0].length
      continue
    }
    const emphasis = matchEmphasis(rest, buffer)
    if (emphasis !== undefined) {
      flush()
      out.push(emphasis.inline)
      index += emphasis.length
      continue
    }
    const link = /^\[([^\]\n]*)\]\(\s*([^)\s]+?)(?:\s+"[^"]*")?\s*\)/.exec(rest)
    if (link !== null && SAFE_URL.test(link[2] ?? '')) {
      flush()
      out.push({ kind: 'link', url: link[2] ?? '', children: parseInline(link[1] ?? '', depth + 1) })
      index += link[0].length
      continue
    }
    const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(rest)
    if (auto !== null) {
      flush()
      out.push({ kind: 'link', url: auto[1] ?? '', children: [{ kind: 'text', text: auto[1] ?? '' }] })
      index += auto[0].length
      continue
    }
    const bare = /^(?:https?:\/\/|mailto:)[^\s<>"'`]+/.exec(rest)
    if (bare !== null) {
      const url = trimUrl(bare[0])
      if (url.length > 0) {
        flush()
        out.push({ kind: 'link', url, children: [{ kind: 'text', text: url }] })
        index += url.length
        continue
      }
    }
    buffer += source[index] ?? ''
    index += 1
  }
  flush()
  return out
}

/** Index of the next character that can start an inline run, or the line length. */
function nextSpecial(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    if (SPECIAL.includes(source[index] ?? '')) return index
  }
  return source.length
}

/** Drop the sentence punctuation a bare URL picked up from the prose around it. */
function trimUrl(url: string): string {
  let end = url.length
  for (;;) {
    const char = url[end - 1]
    if (char === undefined) break
    if ('.。，,;:!?'.includes(char)) { end -= 1; continue }
    if (char === ')' && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) { end -= 1; continue }
    if (char === ']' || char === '}') { end -= 1; continue }
    break
  }
  return url.slice(0, end)
}

/** One matched emphasis run and the characters it consumed. */
interface Emphasis { inline: Inline; length: number }

/**
 * Match an emphasis, strike, or strong run at the start of the rest of a line.
 * @param rest - the line from the current position.
 * @param buffer - text already consumed, so an underscore can refuse to split a word.
 */
function matchEmphasis(rest: string, buffer: string): Emphasis | undefined {
  for (const { marker, kind } of [
    { marker: '**', kind: 'strong' },
    { marker: '__', kind: 'strong' },
    { marker: '~~', kind: 'del' },
    { marker: '*', kind: 'em' },
    { marker: '_', kind: 'em' },
  ] as const) {
    if (!rest.startsWith(marker)) continue
    const close = rest.indexOf(marker, marker.length)
    if (close < 0) continue
    const inner = rest.slice(marker.length, close)
    if (inner.length === 0 || inner.trim() !== inner || inner.includes('\n')) continue
    if (marker.startsWith('_')) {
      const before = buffer.slice(-1)
      const after = rest[close + marker.length] ?? ''
      if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue
    }
    const children = parseInline(inner, MAX_DEPTH)
    const inline: Inline = kind === 'strong' ? { kind: 'strong', children }
      : kind === 'del' ? { kind: 'del', children } : { kind: 'em', children }
    return { inline, length: close + marker.length }
  }
  return undefined
}

/**
 * Split a table row into its cells.
 * @param line - the row, with or without its outer pipes.
 * @returns one entry per cell; a pipe escaped by a backslash stays inside its cell.
 */
export function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let buffer = ''
  let escaped = false
  for (const char of trimmed) {
    if (escaped) {
      if (char === '|') buffer = buffer.slice(0, -1)
      buffer += char
      escaped = false
      continue
    }
    if (char === '\\') { escaped = true; buffer += char; continue }
    if (char === '|') { cells.push(buffer); buffer = ''; continue }
    buffer += char
  }
  cells.push(buffer)
  return cells
}

/** Read a table delimiter row, or nothing when the line is not one. */
function delimiterRow(line: string): Align[] | undefined {
  if (!line.includes('-')) return undefined
  const cells = splitCells(line)
  if (cells.length === 0) return undefined
  const align: Align[] = []
  for (const cell of cells) {
    const text = cell.trim()
    if (!/^:?-+:?$/.test(text)) return undefined
    align.push(text.startsWith(':') && text.endsWith(':') ? 'center' : text.endsWith(':') ? 'end' : 'start')
  }
  return align
}

/** Read a fenced code block starting at a line, or nothing when no fence starts there. */
function readFence(lines: readonly string[], index: number): { block: Block; next: number } | undefined {
  const open = FENCE.exec(lines[index] ?? '')
  if (open === null) return undefined
  const marker = open[1] ?? ''
  const closer = new RegExp('^ {0,3}' + marker[0]!.repeat(marker.length) + marker[0] + '*[ \\t]*$')
  const body: string[] = []
  let cursor = index + 1
  while (cursor < lines.length && !closer.test(lines[cursor] ?? '')) {
    body.push(lines[cursor] ?? '')
    cursor += 1
  }
  if (cursor < lines.length) cursor += 1
  const info = (open[2] ?? '').replace(/^[{.]|}$/g, '')
  return { block: { kind: 'code', lang: info.split(/[\s,]/)[0] ?? '', text: body.join('\n') }, next: cursor }
}

/** Read a list starting at a line, or nothing when no item starts there. */
function readList(lines: readonly string[], index: number): { block: Block; next: number } | undefined {
  const first = ITEM.exec(lines[index] ?? '')
  if (first === null) return undefined
  const rootIndent = (first[1] ?? '').length
  const root: ListItem[] = []
  const stack: { indent: number; items: ListItem[] }[] = [{ indent: rootIndent, items: root }]
  let last: ListItem | undefined
  let cursor = index
  while (cursor < lines.length) {
    const line = lines[cursor] ?? ''
    const item = ITEM.exec(line)
    if (item !== null) {
      const indent = (item[1] ?? '').length
      while (stack.length > 1 && indent < (stack[stack.length - 1]?.indent ?? 0)) stack.pop()
      const top = stack[stack.length - 1]!
      const ordered = !/^[-*+]$/.test(item[2] ?? '')
      let target = top.items
      if (indent > top.indent && top.items.length > 0) {
        const parent = top.items[top.items.length - 1]!
        const nested: ListItem[] = []
        parent.blocks.push({
          kind: 'list',
          ordered,
          start: ordered ? Number.parseInt(item[2] ?? '1', 10) : 1,
          items: nested,
        })
        stack.push({ indent, items: nested })
        target = nested
      }
      last = { lines: [parseInline(item[3] ?? '')], blocks: [] }
      target.push(last)
      cursor += 1
      continue
    }
    if (line.trim().length === 0) {
      let ahead = cursor + 1
      while (ahead < lines.length && (lines[ahead] ?? '').trim().length === 0) ahead += 1
      const next = lines[ahead] ?? ''
      const indented = next.length - next.trimStart().length >= rootIndent + 2
      if (ITEM.test(next) || (indented && next.trim().length > 0)) { cursor = ahead; continue }
      break
    }
    const indent = line.length - line.trimStart().length
    if (last !== undefined && indent >= rootIndent + 2) {
      last.lines.push(parseInline(line.trim()))
      cursor += 1
      continue
    }
    break
  }
  return {
    block: {
      kind: 'list',
      ordered: !/^[-*+]$/.test(first[2] ?? ''),
      start: /^[-*+]$/.test(first[2] ?? '') ? 1 : Number.parseInt(first[2] ?? '1', 10),
      items: root,
    },
    next: cursor,
  }
}

/** Read the blocks of a document. */
function readBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) { index += 1; continue }

    const fence = readFence(lines, index)
    if (fence !== undefined) {
      blocks.push(fence.block)
      index = fence.next
      continue
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, children: parseInline(heading[2] ?? '') })
      index += 1
      continue
    }

    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = []
      while (index < lines.length) {
        const quoted = lines[index] ?? ''
        if (/^ {0,3}>/.test(quoted)) {
          inner.push(quoted.replace(/^ {0,3}> ?/, ''))
          index += 1
          continue
        }
        if (quoted.trim().length === 0 || ITEM.test(quoted) || FENCE.test(quoted)) break
        inner.push(quoted)
        index += 1
      }
      blocks.push({ kind: 'quote', blocks: readBlocks(inner) })
      continue
    }

    const list = readList(lines, index)
    if (list !== undefined) {
      blocks.push(list.block)
      index = list.next
      continue
    }

    const align = delimiterRow(lines[index + 1] ?? '')
    if (align !== undefined && line.includes('|')) {
      const head = splitCells(line).map(cell => parseInline(cell.trim()))
      const rows: Inline[][][] = []
      index += 2
      while (index < lines.length) {
        const row = lines[index] ?? ''
        if (row.trim().length === 0 || !row.includes('|')) break
        rows.push(splitCells(row).map(cell => parseInline(cell.trim())))
        index += 1
      }
      blocks.push({ kind: 'table', align, head, rows })
      continue
    }

    const paragraph: Inline[][] = []
    while (index < lines.length) {
      const text = lines[index] ?? ''
      if (text.trim().length === 0) break
      if (paragraph.length > 0 && startsBlock(lines, index)) break
      paragraph.push(parseInline(text.trim()))
      index += 1
    }
    blocks.push({ kind: 'paragraph', lines: paragraph })
  }
  return blocks
}

/** Whether a line starts a block, which ends the paragraph before it. */
function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ''
  if (FENCE.test(line)) return true
  if (/^ {0,3}#{1,6}\s+/.test(line)) return true
  if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) return true
  if (/^ {0,3}>/.test(line)) return true
  if (ITEM.test(line)) return true
  return line.includes('|') && delimiterRow(lines[index + 1] ?? '') !== undefined
}

/**
 * Parse a Markdown document into blocks.
 * @param source - the document as written, with whatever line endings.
 * @returns the blocks in document order.
 */
export function parseMarkdown(source: string): Block[] {
  return readBlocks(source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'))
}

/**
 * Inline runs of plain text with its bare URLs linked.
 *
 * A person's message is not Markdown — the harness shows it as written — but a
 * URL in it should still open.
 * @param source - one line of plain text.
 * @returns text and link runs in order.
 */
export function linkify(source: string): Inline[] {
  const out: Inline[] = []
  const pattern = /(?:https?:\/\/|mailto:)[^\s<>"'`]+/g
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    const url = trimUrl(match[0])
    if (url.length === 0) continue
    if (start > cursor) out.push({ kind: 'text', text: source.slice(cursor, start) })
    out.push({ kind: 'link', url, children: [{ kind: 'text', text: url }] })
    cursor = start + url.length
  }
  if (cursor < source.length) out.push({ kind: 'text', text: source.slice(cursor) })
  return out
}

