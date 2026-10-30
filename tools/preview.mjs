// Plays the Cargo Belt scene in your terminal without Claude Code.
//   node tools/preview.mjs           loop forever, 136 columns
//   node tools/preview.mjs 100       loop at 100 columns
// Needs a terminal with truecolor (Windows Terminal, iTerm2, most Linux terminals). Ctrl+C to quit.

import { fire, step, frame, play, SCRIPT } from './harness.mjs'

const columns = Math.max(70, Math.min(Number(process.argv[2]) || 136, 200))
const TICK = 1000 / 72
const FRAME_MS = 50

const rgb = (v) => `${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`
function ansi(fr) {
  let out = ''
  for (let r = 0; r < fr.rows; r++) {
    for (let x = 0; x < fr.columns; x++) {
      const i = (r * fr.columns + x) * 3
      out += `\x1b[38;2;${rgb(fr.cells[i + 1])}m\x1b[48;2;${rgb(fr.cells[i + 2])}m${String.fromCodePoint(fr.cells[i])}`
    }
    out += '\x1b[0m\n'
  }
  return out + `\x1b[2m${fr.status}\x1b[0m\x1b[K\n`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.stdout.write('\x1b[?25l\x1b[2J')
process.on('SIGINT', () => { process.stdout.write('\x1b[0m\x1b[?25h\n'); process.exit(0) })

for (;;) {
  await fire('turn.start')
  for (const [name, args, wait] of SCRIPT) {
    await play(name, args)
    for (let t = 0; t < wait; t += FRAME_MS / TICK) {
      step(FRAME_MS)
      const fr = await frame(columns)
      if (fr) process.stdout.write('\x1b[H' + ansi(fr))
      await sleep(FRAME_MS)
    }
  }
}
