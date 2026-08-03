/**
 * The chart palette, validated rather than chosen.
 *
 * These are not eyeballed. They were run through the six computable checks —
 * lightness band, chroma floor, colour-vision separation, normal-vision floor,
 * contrast — against THIS app's chart surface (`#111318`, the card background),
 * in dark mode:
 *
 *   8 slots, adjacent pairs   worst CVD ΔE 8.4 · worst normal ΔE 19.3 · ALL PASS
 *   first 3, all pairs        worst CVD ΔE 9.4 · worst normal ΔE 20.9 · ALL PASS
 *
 * So: up to three series may share a chart where any pair can end up side by side
 * (a scatter, a map); beyond three, fold the tail into "others" or split the
 * chart. Slots are assigned in fixed order and never cycled — a colour belongs to
 * a series, not to its rank, so filtering one out must not repaint the rest.
 *
 * They are deliberately NOT the app's status colours (`proof`, `halt`, `fail`,
 * `run`). Those mean a state — proven, stopped, broken, running — and reusing
 * green for "series 3" would make a chart say something it does not mean.
 */
export const CATEGORICAL = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#008300', // 6 green
  '#9085e9', // 7 violet
  '#e66767', // 8 red
] as const

/** One measure, many rows: every bar is the same hue. Rank is not identity. */
export const MEASURE = CATEGORICAL[0]

/** The tail of a long-tailed list. Grey on purpose: it is not a category. */
export const OTHER = '#3a4152'

/** A series keeps its slot for the life of the chart, whatever the filter. */
export function slotOf(key: string, order: readonly string[]): string {
  const i = order.indexOf(key)
  return i >= 0 && i < CATEGORICAL.length ? CATEGORICAL[i] : OTHER
}

export function money(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** "2026-08-02" → "02/08", the form used everywhere else on these screens. */
export function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}
