import { Vector } from '../utils/vector'
import { type GearInstance, decodeGear } from '../utils/gear'

/**
 * One record's fields, decoded: `[field index][payload]` repeated, indexed
 * into `fields` (`Game.deserialiseBinary`'s `allFields`, which must stay
 * identical to the server's `GameObject.fieldOrder`; fieldtable.spec.ts reads
 * it there). Out of game.ts so that it runs without pixi's display objects
 * (worlds-per-process: `runmap.spec.ts` plays a client through two worlds).
 */
export function decodeRecord (raw: ArrayBuffer | Uint8Array, fields: readonly string[]): any {
  const buffer = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const data: Record<string, number | Vector | string | number[] | GearInstance | null | Array<GearInstance | null>> = {}
  let offset = 0
  while (offset < buffer.length) {
    let value
    const keyIndex = buffer[offset++]
    const key = fields[keyIndex]

    // An unrecognised key index means the stream is already misaligned and
    // there is no way to know how wide the payload is. Keep what parsed
    // cleanly rather than emitting garbage for every field after it.
    if (key === undefined) {
      console.warn('unknown field index', keyIndex, 'in', buffer)
      break
    }

    switch (key) {
      case 'id':
        value = (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'type':
        value = buffer[offset++]
        break
      case 'position':
        value = new Vector(
          (buffer[offset++] << 8) + buffer[offset++],
          (buffer[offset++] << 8) + buffer[offset++]
        )
        break
      case 'hp':
        value = (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'level':
        value = buffer[offset++]
        break
      case 'loot':
        value = (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'loot32':
        // Left undefined in value, so it is stored as loot rather than loot32.
        data.loot = ((buffer[offset++] << 24) >>> 0) + (buffer[offset++] << 16) +
          (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'tag':
        value = overflow(buffer[offset++], 128)
        break
      case 'to':
        value = overflow(buffer[offset++], 128)
        break
      case 'radius':
        value = buffer[offset++]
        break
      case 'lifetime':
        value = ((buffer[offset++] << 8) + buffer[offset++]) * 100
        break
      case 'maxVelocity':
        value = buffer[offset++] * 10
        break
      case 'maxHp':
        value = (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'facing':
        value = buffer[offset++]
        break
      case 'armor':
        value = (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'maxArmor':
        value = (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'kills':
      case 'collector':
        value = (buffer[offset++] << 8) + buffer[offset++]
        break
      case 'archetype':
        value = buffer[offset++]
        break
      case 'item':
      case 'projectile':
        value = buffer[offset++]
        break
      case 'inventory':
      case 'finish': {
        // A count, then that many bytes: counts per slot, or the finish's
        // colour and pattern ids (read by `finishFromBytes`).
        const slots = buffer[offset++]
        const counts: number[] = []
        for (let i = 0; i < slots; i++) counts.push(buffer[offset++])
        value = counts
        break
      }
      case 'extractProgress':
        value = buffer[offset++]
        break
      case 'gear': {
        // A uint8 count, then one instance (decision #49). Null for one this
        // build can't read (an unknown skill or tier), so the pickup still
        // draws, as an unknown item.
        const n = buffer[offset++]
        data.gear = decodeGear(buffer.subarray(offset, offset + n)) ?? null
        offset += n
        break
      }
      case 'carried': {
        // A uint16 count, then the entries (`decodeCarried`).
        const n = (buffer[offset++] << 8) + buffer[offset++]
        data.carried = decodeCarried(buffer.subarray(offset, offset + n))
        offset += n
        break
      }
      case 'speed':
        // Tenths in a uint16, stored as maxVelocity like loot32 as loot, so
        // everything downstream reads one name (49-2).
        data.maxVelocity = ((buffer[offset++] << 8) + buffer[offset++]) / 10
        break
      case 'name': {
        // NUL-terminated UTF-8 (the server writes Buffer.from(name)). It used
        // to be read one byte per char code, which turns any name outside
        // ASCII into mojibake - harmless while every name was a hex id,
        // wrong now that players type their own.
        const start = offset
        while (offset < buffer.length && buffer[offset] !== 0) offset++
        value = new TextDecoder().decode(buffer.subarray(start, offset))
        offset++ // the NUL
        break
      }
    }

    if (value !== undefined) data[key] = value
  }

  return data
}

/**
 * The `carried` field's bytes (decision #49): `[uint8 entries]` then per entry
 * `[uint8 len][instance]`, len 0 an empty entry. Entries 0-1 are the gear
 * slots (keys 3 and 4), 2-5 the bag. Always `CARRIED_ENTRIES` long: missing
 * entries are null, extra ones (a later server) are ignored, and an entry this
 * build can't read is null.
 */
export const CARRIED_ENTRIES = 6

export function decodeCarried (bytes: Uint8Array): Array<GearInstance | null> {
  const out: Array<GearInstance | null> = []
  const count = bytes[0] ?? 0
  let at = 1
  for (let i = 0; i < count && at < bytes.length; i++) {
    const len = bytes[at++]
    out.push(len > 0 ? decodeGear(bytes.subarray(at, at + len)) ?? null : null)
    at += len
  }
  while (out.length < CARRIED_ENTRIES) out.push(null)
  return out.slice(0, CARRIED_ENTRIES)
}

/** A signed byte read unsigned: tags and `to` are int8 on the wire. */
function overflow (value: number, limit: number): number {
  if (value >= limit) value -= 2 * limit
  return value
}
