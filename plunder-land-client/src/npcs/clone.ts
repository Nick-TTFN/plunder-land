/**
 * A deep copy of plain data (objects, arrays, numbers, strings, booleans,
 * null), as the packages' `structuredClone` makes of a pose: numbers are
 * copied exactly. Undefined members are kept as undefined.
 */
export function deepClone<T> (value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value)) out[k] = deepClone((value as Record<string, unknown>)[k])
  return out as T
}
