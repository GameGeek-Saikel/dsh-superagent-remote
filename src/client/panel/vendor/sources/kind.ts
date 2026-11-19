/**
 * Trimmed copy of the upstream sources/kind.ts.
 *
 * The settings and policy forms are described by FieldSpec, AdmissionRowView, and
 * Localized; the rest of the upstream contract describes a Source plugin to the
 * host, which the browser half never builds. These declarations are copied
 * unchanged.
 */

export interface Localized { zh: string; en: string }

/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }

/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, and `fact` displays a read-only value from `facts`.
 */
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & {
      type: 'rows'
      columns: (
        | { key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized }
        | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] }
      )[]
    }

export interface AdmissionRowView {
  id: string
  label: Localized | string
  note: Localized
  cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean }
}
