/**
 * Every interest test again, with each client connected for one frame per
 * tick (`?frames=1`, server-cpu-trim). The mirror client there gets the
 * frames split back into events by the real client's `unpackFrame`, so this
 * checks that framing keeps every event, its bytes and its order.
 */
process.env.INTEREST_SPEC_FRAMED = '1'
require('./interest.spec') // eslint-disable-line @typescript-eslint/no-var-requires
