import Portal from '../objects/portal'

/**
 * The pad at the end of a first run (decision #58, task retest-4): standing
 * on it hands the run off into layer 0 of a shared world (`Worlds.handoff`).
 *
 * **On the wire it is a portal** (`ObjectType` 8), so the client draws it
 * with no new code. It leads to its own layer (`to === tag`), which every
 * portal rule already treats as leading nowhere (`World.portalOn`,
 * `World.isArrival`, the client's `_stopsOn`): it hops nobody, ends no route
 * and is no arrival cell. The client labels it with the layer it names,
 * LAYER 01, which is where it takes the player. The `handoff` flag is what
 * `Player.onHandoffGate` looks for, server-side only. An exit pad was
 * rejected: its channel and EXTRACTING cues say the player is leaving.
 */
export default class HandoffGate extends Portal {
  readonly handoff = true

  /**
   * `to` defaults to `tag`: the first run's pad. A partial world's pad out of
   * the world (decision #60, `WorldOptions.layers`) names the layer it leads
   * to, one the world does not hold: `World.portalOn` skips it (so it hops
   * nobody), `World.padOn` finds it, a route ends on it as the client's
   * `_stopsOn` ends one on any portal to another tag, and the client labels
   * it with that layer.
   */
  constructor (x: number, y: number, tag: number, to: number = tag) {
    super(x, y, to, tag)
  }
}
