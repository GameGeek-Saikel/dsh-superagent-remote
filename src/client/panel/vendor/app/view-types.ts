/**
 * Response shapes of the deployment's management API, as the vendored panel reads
 * them.
 *
 * Upstream derives these from the host modules that build them, which would drag
 * the whole host into the browser bundle's type graph. The panel only narrows
 * them at render time, so they are deliberately loose here; the fields it relies
 * on are pinned by tests/wire.spec.ts against a recorded management API answer.
 *
 * Keep this file in sync with the upstream views when the panel is updated.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type StateView = any
export type OverviewView = any
export type SearchView = any
export type SourceStatusView = any
export type SettingsView = any
export type ThreadListView = any
export type ThreadDetailView = any
export type DecisionListView = any
export type TicketListView = any
export type TicketPageView = any
export type HistoryView = any
export type PromptsView = any
export type PromptConfig = any
export type PromptsPreview = any
