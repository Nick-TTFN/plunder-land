#!/usr/bin/env node
/*
 * `npm test` with a memory ceiling.
 *
 * Runs `node --test --require ts-node/register <specs>` in its own process group
 * and samples every process in that group (the runner and one child per spec
 * file) with `ps` twice a second. If one process passes TEST_MAX_MB (default
 * 2048) or the group passes TEST_TOTAL_MB (default 12288), the whole group is
 * killed, the largest processes are printed with their spec file, and this
 * exits 1.
 *
 * Why not `--max-old-space-size`: the runaway specs this was written for
 * (2026-11-06, private-6 work in progress: worlds, runmap, stash, firstrun
 * specs at ~1.5 GB/s each) grow outside the V8 heap, and a 1 GB heap cap let a
 * spec reach 4.2 GB in 2 s. Run in parallel, they swapped a 36 GB Mac to a
 * hard reset twice. Only an RSS check from outside stops that.
 *
 * Normal peaks, for setting the limits: one spec file alone 0.6-0.95 GB
 * (spawn.spec is the largest).
 *
 * Usage: node tools/test-guard.cjs [spec files...]   (default: every spec)
 */
'use strict'
const { spawn, execFileSync } = require('node:child_process')

const MAX_KB = Number(process.env.TEST_MAX_MB || 2048) * 1024
const TOTAL_KB = Number(process.env.TEST_TOTAL_MB || 12288) * 1024
const files = process.argv.slice(2)
const args = ['--test', '--require', 'ts-node/register', ...(files.length > 0 ? files : ['src/**/*.spec.ts'])]

const child = spawn(process.execPath, args, { stdio: 'inherit', detached: true })
let peakTotal = 0
let peakOne = 0
let killed = false

function group () {
  let out
  try {
    out = execFileSync('ps', ['-axo', 'pid=,pgid=,rss=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch {
    return []
  }
  const rows = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m !== null && Number(m[2]) === child.pid) rows.push({ pid: Number(m[1]), rss: Number(m[3]), args: m[4] })
  }
  return rows
}

function label (row) {
  const spec = /(\S+\.spec\.ts)/.exec(row.args)
  return spec !== null ? spec[1] : row.args.slice(0, 120)
}

function killGroup () {
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
}

const timer = setInterval(() => {
  const rows = group()
  const total = rows.reduce((sum, row) => sum + row.rss, 0)
  const largest = rows.reduce((max, row) => Math.max(max, row.rss), 0)
  peakTotal = Math.max(peakTotal, total)
  peakOne = Math.max(peakOne, largest)
  if (largest <= MAX_KB && total <= TOTAL_KB) return
  killed = true
  killGroup()
  const why = largest > MAX_KB ? `one spec process over ${MAX_KB / 1024} MB` : `the suite over ${TOTAL_KB / 1024} MB`
  console.error(`\ntest-guard: KILLED the suite: ${why} (TEST_MAX_MB / TEST_TOTAL_MB to change).`)
  for (const row of rows.sort((a, b) => b.rss - a.rss).slice(0, 5)) {
    console.error(`  ${Math.round(row.rss / 1024)} MB  ${label(row)}`)
  }
}, 500)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { killGroup(); process.exit(130) })
}

child.on('exit', (code, signal) => {
  clearInterval(timer)
  console.error(`test-guard: peak ${Math.round(peakTotal / 1024)} MB total, ${Math.round(peakOne / 1024)} MB one process.`)
  process.exit(killed ? 1 : (code ?? (signal !== null ? 1 : 0)))
})
