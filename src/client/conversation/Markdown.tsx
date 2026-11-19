/**
 * Rendering of one message's Markdown, in the harness conversation's type.
 *
 * Blocks and runs come from ./markdown.ts; this file only decides which element
 * each one becomes. The class names are the hook the stylesheet uses, and every
 * node is a React element, so raw HTML in the source can never become markup.
 */
import { Fragment, useMemo, type CSSProperties } from 'react'
import type { T } from '../locales.ts'
import { CopyButton, useCopy, type CopyState } from './copy.tsx'
import { parseMarkdown, type Align, type Block, type Inline, type ListItem } from './markdown.ts'

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

/**
 * Render the Markdown of one message.
 * @param text - the message body, as written.
 * @param t - translator for the copy labels.
 */
export function ChatMarkdown({ text, t }: { text: string; t: T }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const copy = useCopy()
  return <div className="sar-md"><Blocks blocks={blocks} t={t} copy={copy} path="md" /></div>
}

/** Shared props of the recursive renderers; path keeps copy keys unique. */
interface Nested { t: T; copy: CopyState; path: string }

/** Render a run of sibling blocks. */
function Blocks({ blocks, t, copy, path }: Nested & { blocks: Block[] }) {
  return <>{blocks.map((block, index) => <BlockView key={index} block={block} t={t} copy={copy}
    path={path + '.' + String(index)} />)}</>
}

/** Render one block. */
function BlockView({ block, t, copy, path }: Nested & { block: Block }) {
  switch (block.kind) {
    case 'paragraph':
      return <p className="sar-md-p">{block.lines.map((line, index) => <Fragment key={index}>
        {index > 0 && <br />}<Inlines runs={line} /></Fragment>)}</p>
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6)
      const Tag = HEADINGS[level - 1] ?? 'h6'
      return <Tag className="sar-md-heading" data-level={level}><Inlines runs={block.children} /></Tag>
    }
    case 'code':
      return <div className="sar-md-code-block">
        <div className="sar-md-code-bar">
          <span className="sar-md-code-lang">{block.lang.length > 0 ? block.lang : 'text'}</span>
          <CopyButton text={block.text} label={t('chat.copy')} copiedLabel={t('chat.copied')} state={copy}
            itemKey={path} className="sar-md-code-copy" />
        </div>
        <pre className="sar-md-pre"><code>{block.text}</code></pre>
      </div>
    case 'list':
      return block.ordered
        ? <ol className="sar-md-list" start={block.start === 1 ? undefined : block.start}>
          {block.items.map((item, index) => <Item key={index} item={item} t={t} copy={copy}
            path={path + '.' + String(index)} />)}
        </ol>
        : <ul className="sar-md-list">
          {block.items.map((item, index) => <Item key={index} item={item} t={t} copy={copy}
            path={path + '.' + String(index)} />)}
        </ul>
    case 'quote':
      return <blockquote className="sar-md-quote"><Blocks blocks={block.blocks} t={t} copy={copy} path={path} /></blockquote>
    case 'rule':
      return <hr className="sar-md-rule" />
    case 'table':
      return <div className="sar-md-table-scroll">
        <table className="sar-md-table">
          <thead><tr>{block.head.map((cell, index) => <th key={index} style={alignOf(block.align[index])}>
            <Inlines runs={cell} /></th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) =>
            <td key={cellIndex} style={alignOf(block.align[cellIndex])}><Inlines runs={cell} /></td>)}</tr>)}</tbody>
        </table>
      </div>
  }
}

/** The CSS alignment one table column asked for. */
function alignOf(align: Align | undefined): CSSProperties {
  return { textAlign: align ?? 'start' }
}

/** Render one list item: its own lines, then whatever nests under it. */
function Item({ item, t, copy, path }: Nested & { item: ListItem }) {
  return <li className="sar-md-item">{item.lines.map((line, index) => <Fragment key={index}>
    {index > 0 && <br />}<Inlines runs={line} /></Fragment>)}
    {item.blocks.length > 0 && <Blocks blocks={item.blocks} t={t} copy={copy} path={path} />}
  </li>
}

/** Render one line of inline runs. */
function Inlines({ runs }: { runs: Inline[] }) {
  return <>{runs.map((run, index) => {
    switch (run.kind) {
      case 'text':
        return <Fragment key={index}>{run.text}</Fragment>
      case 'code':
        return <code key={index} className="sar-md-inline-code">{run.text}</code>
      case 'strong':
        return <strong key={index}><Inlines runs={run.children} /></strong>
      case 'em':
        return <em key={index}><Inlines runs={run.children} /></em>
      case 'del':
        return <del key={index}><Inlines runs={run.children} /></del>
      case 'link':
        return <a key={index} className="sar-md-link" href={run.url} target="_blank" rel="noopener noreferrer">
          <Inlines runs={run.children} /></a>
    }
  })}</>
}

/**
 * Render one line of plain text with its URLs linked, for a message the writer
 * did not mark up.
 * @param runs - text and link runs of one line.
 */
export function PlainLine({ runs }: { runs: Inline[] }) {
  return <Inlines runs={runs} />
}
