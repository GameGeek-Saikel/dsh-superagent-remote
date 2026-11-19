/**
 * One width handle on the edge of the conversation column.
 *
 * The harness keeps a handle in each gutter beside the content column: a narrow
 * strip that shows a 2px grip at the pointer's height while hovered or dragged,
 * and widens or narrows the column as it is dragged. Vertical wheel events pass
 * through to the transcript, so resting on the gutter does not trap scrolling.
 */

import { useCallback, useRef } from 'react'

/** Which edge of the column a handle sits on. */
export type HandleSide = 'left' | 'right'

/**
 * The width a drag asks for.
 *
 * Dragging away from the element widens it, on either side. A centered column
 * moves each edge by half of a width change, so it passes `scale` 2 to keep the
 * handle under the pointer; an edge that is itself the boundary passes 1.
 * @param side - the edge being dragged.
 * @param origin - where the drag started, in client pixels.
 * @param latest - where the pointer is now, in client pixels.
 * @param base - the width the drag started from.
 * @param scale - how much width one pixel of travel asks for.
 */
export function outwardWidth(side: HandleSide, origin: number, latest: number, base: number, scale = 2): number {
  const travelled = latest - origin
  return base + (side === 'right' ? travelled : -travelled) * scale
}

/**
 * Render one drag handle.
 * @param side - which edge it sits on.
 * @param className - the class that places it; the grip styles hang off it.
 * @param scale - how much width one pixel of travel asks for.
 * @param onStart - returns the width the drag starts from.
 * @param onDrag - receives the width the pointer asks for, once per frame.
 * @param onCommit - receives the final width when the drag ends.
 */
export function WidthHandle({ side, className = 'sar-width-handle', scale = 2, onStart, onDrag, onCommit }: {
  side: HandleSide; className?: string; scale?: number
  onStart: () => number; onDrag: (width: number) => void; onCommit: (width: number) => void
}) {
  const drag = useRef<{ origin: number; latest: number; base: number } | undefined>(undefined)
  const frame = useRef<number | undefined>(undefined)

  const cancelFrame = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    frame.current = undefined
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { origin: event.clientX, latest: event.clientX, base: onStart() }
    event.currentTarget.setAttribute('data-dragging', '')
  }, [onStart])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (state === undefined) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === false) return
    const box = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--sar-width-handle-pointer-y', (event.clientY - box.top) + 'px')
    state.latest = event.clientX
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      const current = drag.current
      if (current !== undefined) onDrag(outwardWidth(side, current.origin, current.latest, current.base, scale))
    })
  }, [onDrag, scale, side])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (state === undefined) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === false) return
    drag.current = undefined
    event.currentTarget.removeAttribute('data-dragging')
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    cancelFrame()
    state.latest = event.clientX
    if (state.latest !== state.origin) onCommit(outwardWidth(side, state.origin, state.latest, state.base, scale))
  }, [cancelFrame, onCommit, scale, side])

  const onPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current === undefined) return
    drag.current = undefined
    event.currentTarget.removeAttribute('data-dragging')
    cancelFrame()
  }, [cancelFrame])

  // The gutter has no scroll of its own, so a vertical wheel belongs to the transcript.
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.deltaY === 0) return
    const scroller = event.currentTarget.closest('.sar-conv')?.querySelector('[data-conversation-scroll]')
    if (scroller instanceof HTMLElement) scroller.scrollBy({ top: event.deltaY })
  }, [])

  return <div className={className} data-side={side} data-width-handle={side}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel} onLostPointerCapture={onPointerCancel} onWheel={onWheel} />
}
