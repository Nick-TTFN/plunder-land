import type Player from '../objects/player'
import { ITEMS, type Item } from '../archetypes/archetypes'
import { type Vector } from '../utils/vector'
import { throwBomb } from './bomb'

/** The server's `Item` living in a 0-based slot, or undefined for an empty or out-of-range slot. */
export function itemForSlot (slot: number): Item | undefined {
  for (const key in ITEMS) {
    const item = ITEMS[key as keyof typeof ITEMS]
    if (item.slot === slot) return item
  }
  return undefined
}

/**
 * Do what `item` does, for `player`. True if it happened, and only then does
 * `Player.tryUseItem` spend one. Dispatched on the behaviour (`ItemUse.kind`),
 * never on which item it is, so an item that heals or blasts differently is a
 * row in `ITEMS`, not a case here.
 *
 * An item that does not aim (`aimRange` null) is never handed the aim.
 */
export function useItem (player: Player, item: Item, aimCell?: Vector): boolean {
  const use = item.use
  switch (use.kind) {
    case 'heal':
      return player.startHeal(use.amount, use.durationMs)
    case 'bomb':
      return throwBomb(player, item, use, item.aimRange === null ? undefined : aimCell)
  }
  // A kind added to ItemUse without a case here is refused, not a crash.
  return false
}
