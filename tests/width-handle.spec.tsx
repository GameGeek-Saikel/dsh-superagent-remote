// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WidthHandle, outwardWidth } from '../src/client/conversation/WidthHandle.tsx'

let cleanup: (() => void) | undefined
let frames: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: () => void): number => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup?.(); cleanup = undefined
  frames = []
  vi.unstubAllGlobals()
})

/** Run the pending animation frame, as a browser would before the next paint. */
async function paint(): Promise<void> {
  await act(async () => {
    const pending = frames
    frames = []
    pending.forEach(callback => callback())
  })
}

/** Render one handle inside a conversation root with a transcript scroller. */
async function mount(side: 'left' | 'right' = 'right', scale = 2, className = 'sar-width-handle'): Promise<{
  container: HTMLDivElement; handle: HTMLDivElement; dragged: number[]; committed: number[]; scrolled: unknown[]
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const dragged: number[] = []
  const committed: number[] = []
  const root = createRoot(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => {
    root.render(<div className="sar-conv">
      <div data-conversation-scroll />
      <WidthHandle side={side} scale={scale} className={className} onStart={() => 700}
        onDrag={next => { dragged.push(next) }} onCommit={next => { committed.push(next) }} />
    </div>)
  })
  cleanup = () => { act(() => root.unmount()); container.remove() }
  const scrolled: unknown[] = []
  const scroller = container.querySelector('[data-conversation-scroll]') as HTMLElement
  scroller.scrollBy = ((options: ScrollToOptions) => { scrolled.push(options) }) as typeof scroller.scrollBy
  const handle = container.querySelector('.' + className) as HTMLDivElement
  return { container, handle, dragged, committed, scrolled }
}

describe('the conversation width handle', () => {
  it('asks for the width the drag moved outward', () => {
    // Dragging outward widens: right by moving right, left by moving left.
    expect(outwardWidth('right', 500, 600, 700)).toBe(900)
    expect(outwardWidth('left', 500, 400, 700)).toBe(900)
    expect(outwardWidth('right', 500, 400, 700)).toBe(500)
    expect(outwardWidth('right', 500, 500, 700)).toBe(700)
    // An edge that is the boundary itself moves one for one.
    expect(outwardWidth('left', 500, 400, 280, 1)).toBe(380)
    expect(outwardWidth('left', 500, 560, 280, 1)).toBe(220)
  })

  it('marks its side and follows the pointer while dragging', async () => {
    const { handle, dragged, committed } = await mount('right')
    expect(handle.getAttribute('data-side')).toBe('right')
    expect(handle.getAttribute('data-width-handle')).toBe('right')
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }))
    })
    expect(handle.hasAttribute('data-dragging')).toBe(true)
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 120 }))
    })
    await paint()
    expect(dragged).toEqual([500])
    expect(handle.style.getPropertyValue('--sar-width-handle-pointer-y')).toBe('120px')
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 400 }))
    })
    expect(committed).toEqual([500])
    expect(handle.hasAttribute('data-dragging')).toBe(false)
  })

  it('asks for the inward width on the left edge', async () => {
    const { handle, dragged } = await mount('left')
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }))
      handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 560 }))
    })
    await paint()
    expect(dragged).toEqual([580])
  })

  it('leaves a click in place without committing a width', async () => {
    const { handle, committed } = await mount()
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }))
      handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 500 }))
    })
    expect(committed).toEqual([])
  })

  it('moves one pixel per pixel on the project pane edge', async () => {
    const { handle, dragged, committed } = await mount('left', 1, 'sar-pane-handle')
    expect(handle.className).toBe('sar-pane-handle')
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }))
      handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 400 }))
    })
    await paint()
    expect(dragged).toEqual([800])
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 400 }))
    })
    expect(committed).toEqual([800])
  })

  it('passes a vertical wheel through to the transcript', async () => {
    const { handle, scrolled } = await mount()
    await act(async () => {
      handle.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
    })
    expect(scrolled).toEqual([{ top: 120 }])
  })
})
