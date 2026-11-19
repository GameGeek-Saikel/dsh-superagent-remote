import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, splitCells, type Block, type Inline } from '../src/client/conversation/markdown.ts'

/** Flatten inline runs to the text they show, for assertions that ignore structure. */
const text = (inlines: Inline[]): string => inlines.map(inline => inline.kind === 'text' ? inline.text
  : inline.kind === 'code' ? inline.text : inline.children.map(child => child.kind === 'text' ? child.text : '').join('')).join('')

const first = (blocks: Block[]): Block => {
  const block = blocks[0]
  if (block === undefined) throw new Error('expected at least one block')
  return block
}

describe('inline Markdown', () => {
  it('reads emphasis, code, strike, and links', () => {
    const runs = parseInline('**bold** and *em* and `code` and ~~gone~~ and [docs](https://example.com/a)')
    expect(runs.map(run => run.kind)).toEqual(['strong', 'text', 'em', 'text', 'code', 'text', 'del', 'text', 'link'])
    expect(text(runs)).toBe('bold and em and code and gone and docs')
    const link = runs.find(run => run.kind === 'link')
    expect(link?.kind === 'link' ? link.url : '').toBe('https://example.com/a')
  })

  it('keeps an underscore inside a word', () => {
    expect(parseInline('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }])
  })

  it('keeps an unmatched marker literal', () => {
    expect(parseInline('5 * 3 * 2')).toEqual([{ kind: 'text', text: '5 * 3 * 2' }])
    expect(parseInline('unclosed **bold')).toEqual([{ kind: 'text', text: 'unclosed **bold' }])
  })

  it('linkifies bare URLs but not their sentence punctuation', () => {
    const runs = parseInline('see https://example.com/a. done')
    expect(runs[0]).toEqual({ kind: 'text', text: 'see ' })
    expect(runs[1]).toEqual({ kind: 'link', url: 'https://example.com/a', children: [{ kind: 'text', text: 'https://example.com/a' }] })
    expect(runs[2]).toEqual({ kind: 'text', text: '. done' })
  })

  it('refuses a link scheme it cannot open', () => {
    const runs = parseInline('[x](javascript:alert(1))')
    expect(runs.every(run => run.kind === 'text')).toBe(true)
  })

  it('leaves raw HTML as text', () => {
    const runs = parseInline('<img src=x onerror=alert(1)>')
    expect(runs.every(run => run.kind === 'text')).toBe(true)
    expect(text(runs)).toBe('<img src=x onerror=alert(1)>')
  })

  it('honours a backslash escape', () => {
    expect(parseInline('\\*not em\\*')).toEqual([{ kind: 'text', text: '*not em*' }])
    expect(parseInline('C:\\Users\\saike')).toEqual([{ kind: 'text', text: 'C:\\Users\\saike' }])
  })
})

describe('block Markdown', () => {
  it('keeps a line break inside a paragraph, as GitHub does', () => {
    const block = first(parseMarkdown('first line\nsecond line\n\nsecond paragraph'))
    expect(block.kind).toBe('paragraph')
    expect(block.kind === 'paragraph' ? block.lines.length : 0).toBe(2)
    expect(parseMarkdown('first line\nsecond line\n\nsecond paragraph')).toHaveLength(2)
  })

  it('reads headings by level', () => {
    const blocks = parseMarkdown('## Two\n\n### Three ###')
    expect(blocks.map(block => block.kind === 'heading' ? block.level : 0)).toEqual([2, 3])
    const head = first(blocks)
    expect(head.kind === 'heading' ? text(head.children) : '').toBe('Two')
  })

  it('reads a nested list', () => {
    const block = first(parseMarkdown('- one\n- two\n  - nested\n- three'))
    expect(block.kind).toBe('list')
    if (block.kind !== 'list') return
    expect(block.ordered).toBe(false)
    expect(block.items).toHaveLength(3)
    expect(text(block.items[0]?.lines[0] ?? [])).toBe('one')
    const nested = block.items[1]?.blocks[0]
    expect(nested?.kind).toBe('list')
    expect(nested?.kind === 'list' ? text(nested.items[0]?.lines[0] ?? []) : '').toBe('nested')
  })

  it('reads an ordered list and its start number', () => {
    const block = first(parseMarkdown('3. three\n4. four'))
    expect(block.kind === 'list' ? [block.ordered, block.start, block.items.length] : []).toEqual([true, 3, 2])
  })

  it('keeps a fenced block verbatim, with its language', () => {
    const block = first(parseMarkdown('```ts\nconst a = 1\n\n  return a\n```'))
    expect(block).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1\n\n  return a' })
  })

  it('closes a fence and continues the document', () => {
    const blocks = parseMarkdown('```\ncode\n```\nafter')
    expect(blocks.map(block => block.kind)).toEqual(['code', 'paragraph'])
  })

  it('reads a block quote', () => {
    const block = first(parseMarkdown('> quoted\n> more'))
    expect(block.kind).toBe('quote')
    expect(block.kind === 'quote' ? block.blocks[0]?.kind : '').toBe('paragraph')
  })

  it('reads a pipe table with alignment', () => {
    const block = first(parseMarkdown('| name | count |\n| --- | ---: |\n| a | 1 |\n| b | 2 |'))
    expect(block.kind).toBe('table')
    if (block.kind !== 'table') return
    expect(block.align).toEqual(['start', 'end'])
    expect(block.head.map(cell => text(cell))).toEqual(['name', 'count'])
    expect(block.rows.map(row => row.map(cell => text(cell)))).toEqual([['a', '1'], ['b', '2']])
  })

  it('reads a rule', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }])
  })

  it('does not read a plain dash line as a table', () => {
    expect(parseMarkdown('text\n---')).toHaveLength(2)
  })
})

describe('table cells', () => {
  it('honours an escaped pipe', () => {
    expect(splitCells('| a \\| b | c |')).toEqual([' a | b ', ' c '])
  })

  it('keeps a trailing backslash in text', () => {
    expect(splitCells('C:\\Users | x')).toEqual(['C:\\Users ', ' x'])
  })
})
