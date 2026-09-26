import { Decoder, Encoder, PacketType } from 'socket.io-parser'

/**
 * One binary frame per tick (server-cpu-trim).
 *
 * socket.io sends every binary event as two WebSocket frames, a text
 * placeholder and then the buffer, and the server sent up to five binary
 * events per player per tick. Each frame is a socket write on the server,
 * which made sending the biggest single cost there. A client that connects
 * with `?frames=1` is instead sent one engine.io message per tick, packed by
 * the server's `Multiplayer.packFrame`:
 *
 * `[uint8 version][uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]`
 * then sections to the end: `[uint8 kind][uint32 length][payload]`.
 *
 * This decoder turns each frame back into the events the game already
 * handles, in the same order the server used to emit them, with the same
 * buffers: `create`, `create_own`, `effect`, `destroy`, `standings`, then
 * always `update` (the header plus its records; the header alone when there
 * are none, because the header is the client's clock). So nothing in the game
 * knows the difference.
 *
 * The server says yes by putting `frames` in `hello`. Until then, and after a
 * disconnect (a reconnect may reach a server that doesn't frame), every
 * message goes to socket.io's own decoder, so this client works against an
 * older server too. A framed connection is sent no socket.io binary events at
 * all, which is why any binary message is a frame once framing is on.
 */

export const FRAME_VERSION = 1
const HEADER_BYTES = 9
const UPDATE_HEADER_BYTES = 8

/** Section kinds. A wire contract, append-only; must match the server's `Multiplayer.FRAME_KINDS`. */
export const FRAME_KINDS: Readonly<Record<number, string>> = {
  1: 'create',
  2: 'create_own',
  3: 'effect',
  4: 'destroy',
  5: 'standings',
  6: 'update'
}

/**
 * The events in one frame, in order, each with its own ArrayBuffer (what the
 * game's handlers read). `update` is always last. Undefined for a frame of a
 * version this client doesn't know, or one too short for its header. A
 * section of an unknown kind is skipped; a truncated one ends the frame.
 */
export function unpackFrame (bytes: Uint8Array): Array<[string, ArrayBuffer]> | undefined {
  if (bytes.length < HEADER_BYTES || bytes[0] !== FRAME_VERSION) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const events: Array<[string, ArrayBuffer]> = []
  let update: Uint8Array | undefined
  let at = HEADER_BYTES
  while (at + 5 <= bytes.length) {
    const kind = bytes[at]
    const length = view.getUint32(at + 1)
    const start = at + 5
    if (start + length > bytes.length) {
      console.warn('truncated frame section', kind)
      break
    }
    at = start + length
    const name = FRAME_KINDS[kind]
    if (name === undefined) continue
    if (name === 'update') {
      update = bytes.subarray(start, start + length)
      continue
    }
    events.push([name, bytes.slice(start, start + length).buffer])
  }
  const records = update?.length ?? 0
  const packet = new Uint8Array(UPDATE_HEADER_BYTES + records)
  packet.set(bytes.subarray(1, HEADER_BYTES), 0)
  if (update !== undefined) packet.set(update, UPDATE_HEADER_BYTES)
  events.push(['update', packet.buffer])
  return events
}

export class FramedDecoder extends Decoder {
  private _framed = false
  private _warned = false

  constructor () {
    super()
    // Registered before the Manager's own listener, so framing is on before
    // the frame that follows `hello` is decoded.
    this.on('decoded', (packet) => {
      if (packet.type !== PacketType.EVENT || !Array.isArray(packet.data)) return
      const [event, data] = packet.data as [unknown, { frames?: unknown } | undefined]
      if (event === 'hello') this._framed = data?.frames === FRAME_VERSION
    })
  }

  add (obj: unknown): void {
    if (!this._framed || typeof obj === 'string') {
      super.add(obj)
      return
    }
    const bytes = obj instanceof ArrayBuffer
      ? new Uint8Array(obj)
      : ArrayBuffer.isView(obj) ? new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength) : undefined
    const events = bytes !== undefined ? unpackFrame(bytes) : undefined
    if (events === undefined) {
      if (!this._warned) console.warn('unreadable frame; dropped')
      this._warned = true
      return
    }
    for (const data of events) this.emitReserved('decoded', { type: PacketType.EVENT, nsp: '/', data })
  }

  destroy (): void {
    this._framed = false
    super.destroy()
  }
}

/** For `io(url, { parser: framedParser, query: { frames: '1' } })`. */
export const framedParser = { Encoder, Decoder: FramedDecoder }
