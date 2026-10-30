// Cargo Belt — a Claude Code mod.
// While Claude works, Clawd (in a yellow hard hat) runs a low conveyor belt above the prompt:
//   reads    -> cardboard boxes
//   edits    -> machined metal parts
//   commands -> orange barrels
//   errors   -> a damaged box falls off, the andon flashes red, the bubble turns red
//   asks     -> the line stops, the andon blinks amber, Clawd waves, the bubble turns amber
//   done     -> Clawd raises a checkered flag and the truck drives off with the cargo
// Controls (when the band has focus): w jump, a left, d right, s get off the belt, e drop a box by hand.

const SPEED = 1.2
const TICK_MS = 1000 / (60 * SPEED)
// Two sizes, "big" by default. "small" packs 2x3 pixels into each terminal cell with sextant characters;
// "big" packs 1x2 pixels per cell with the upper half block. The world is the same in both.
const SIZES = {
  small: { rows: 6, px: 2, py: 3 },
  big: { rows: 8, px: 1, py: 2 },
}
const WORLD_BOTTOM = 34 // the last visible world row is 33
const LINGER_MS = 7000
const CTL = 300
const HALF_BLOCK = 0x2580
const SKY = 0x171823

const BUBBLE = {
  normal: [0x2c2c2a, 0xefe9d8],
  ask: [0x412402, 0xef9f27],
  err: [0xffffff, 0xc93b3a],
}

const hex = (s) => parseInt(s.slice(1), 16)
const P = Object.fromEntries(Object.entries({
  Y: '#F5C842', h: '#FFF0A8', y: '#E0A21E', z: '#B87A10', O: '#D97757', K: '#111111',
  B: '#C8A165', b: '#8F6A35', T: '#E8D9B0', M: '#9AA8B4', m: '#C7D2DB', d: '#4A525A',
  R: '#D85A30', r: '#F0997B', k: '#6B2A14', X: '#E24B4A', x: '#2A0A0A', D: '#A32D2D',
  C: '#378ADD', W: '#B5D4F4', L: '#FCE79A', o: '#D97757', e: '#7A3A26', G: '#1A1A1A',
  g: '#888780', H: '#ED5A6A', n: '#EFE9D8',
}).map(([k, v]) => [k, hex(v)]))

const HAT = ['....YYhhYy....', '...YYYhhYYy...', '.zyyyyyyyyyyz.']
const LEG_A = ['...O.O..O.O...', '...O.O..O.O...']
const LEG_B = ['...O.O..O.O...', '..O.O....O.O..']
const HEART = ['.H.H.', 'HHHHH', '.HHH.', '..H..']
const NOTE = ['..nn', '..n.', 'nnn.', 'nn..']
const TRUCK = [
  '....................CCCCCC..', '...................CCWWWWCC.', '...................CCWWWWCCC',
  '...................CCWWWWCCC', '...................CCCCCCCCC', '...................CCCCCCCLC',
  '...................CCCCCCCCC', 'ooooooooooooooooooooCCCCCCCC', 'eeeeeeeeeeeeeeeeeeeeCCCCCCCC',
  '..GGG..........GGG.....GGG..', '.GGgGG........GGgGG...GGgGG.', '..GGG..........GGG.....GGG..',
]
const ITEM = {
  read: ['bbbbbbbb', 'bBBTTBBb', 'bBBTTBBb', 'bBBBBBBb', 'bbbbbbbb'],
  edit: ['..MMMM..', 'MMmMMmMM', 'MMMddMMM', 'MMmMMmMM', '..MMMM..'],
  bash: ['.RRRR.', 'RrRRRR', 'kkkkkk', 'RrRRRR', 'kkkkkk', '.RRRR.'],
  err: ['DDDDDDDD', 'DXxXXxXD', 'DXXxxXXD', 'DXxXXxXD', 'DDDDDDDD'],
}
const MINI = { read: ['bBBb', 'bTTb', 'bbbb'], edit: ['mMMm', 'MddM', 'mMMm'], bash: ['rRRr', 'kkkk', 'rRRr'] }
const BOXES = new Set(['read', 'edit', 'bash', 'err'])

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BASH_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput'])

// World layout (y grows downward). The belt stands on legs, about chest high for Clawd.
const BELT_SURFACE = 28 // items rest on y = 27
const FLOOR = 32
const HOME = 1
const GROUND = 22 // Clawd's top when standing on the floor (10 px tall)
const BELT_Y = 18 // Clawd's top when riding the belt

// ---- state shared by all hooks ----
let W = 136 // world width in pixels
let size = 'big'
let enabled = true
let working = false
let lingerUntil = 0
let wasVisible = false
let lastTick = Date.now()
let acc = 0
let f = 0
let items = []
let flights = []
let cargo = []
let state = 'run'
let arm = 0
let andonErr = 0
let tx = 0
let belt = 0
let cx = HOME
let cy = GROUND
let vy = 0
let walkT = null
let ctlT = 0
let noLand = 0
let onBelt = false
let blinkT = 0
let roamT = HOME
let roamWait = 0
let emo = null
let sag = 0
let moving = false
let msg = 'Shift started'
let mood = 'normal'

const geo = () => ({ beltEnd: W - 34, andonX: W - 33, truckX: W - 30, maxX: W - 44 })
const visible = () => enabled && (working || Date.now() < lingerUntil || ctlT > 0)
const say = (t, m = 'normal') => { msg = String(t).slice(0, 30); mood = m }
const grounded = () => cy >= GROUND || onBelt
const hop = (v) => { if (grounded()) { vy = v; onBelt = false } }
const overBelt = (x) => x + 11 >= 17 && x + 2 <= geo().beltEnd - 1

function kindOf(tool) {
  if (EDIT_TOOLS.has(tool)) return 'edit'
  if (BASH_TOOLS.has(tool)) return 'bash'
  return 'read'
}

function labelOf(tool, input) {
  const p = input && (input.file_path || input.notebook_path || input.path)
  if (p) return String(p).split(/[\\/]/).pop()
  if (input && input.command) return String(input.command).trim().split(/\s+/).slice(0, 2).join(' ')
  if (input && input.url) { try { return new URL(input.url).hostname } catch { /* not a URL */ } }
  if (input && input.pattern) return String(input.pattern)
  return tool || 'something'
}

function ev(t, label = '') {
  if (state === 'done' && BOXES.has(t)) { state = 'run'; cargo = []; tx = 32 }
  if (state === 'done' && t !== 'done') return
  if (BOXES.has(t)) {
    if (items.length < 12) items.push({ t, x: 16, drop: 0 })
    if (!ctlT) arm = 24
  }
  if (t === 'read') say('Packing ' + label)
  if (t === 'edit') say('Machining ' + label)
  if (t === 'bash') say('Running ' + label)
  if (t === 'err') { say('Oops, damaged box!', 'err'); andonErr = 90 }
  if (t === 'ask') { state = 'stop'; say('? Waiting for your OK', 'ask') }
  if (t === 'ok' && state === 'stop') { state = 'run'; say('Thanks, moving on!'); hop(-0.7); emo = { s: HEART, t: 60 } }
  if (t === 'done') { state = 'done'; say('Shipment done!'); roamWait = 40; hop(-0.7) }
}

function act(k) {
  ctlT = CTL
  const g = geo()
  const from = walkT === null ? cx : walkT
  if (k === 'w') { hop(-0.95); say('Hop!') }
  if (k === 'a') { walkT = Math.max(0, from - 6); say('Your turn!') }
  if (k === 'd') { walkT = Math.min(g.maxX, from + 6); say('Your turn!') }
  if (k === 's' && onBelt) { onBelt = false; vy = 0.3; noLand = 20; say('Off the belt!') }
  if (k === 'e' && state !== 'done') {
    if (items.length < 12) items.push({ t: 'read', x: Math.max(16, Math.min(g.beltEnd - 12, Math.round(cx) + 3)), drop: 0 })
    arm = 16
    say('Placed by hand!')
  }
}

function slotXY(i) {
  const s = Math.min(i, 7)
  return [geo().truckX + 1 + tx + (s % 4) * 5, 24 - Math.floor(s / 4) * 3 + sag]
}

function tick() {
  f++
  const g = geo()
  const onLine = items.some((i) => !i.drop)
  const step = (state === 'run' || (state === 'done' && onLine)) && f % (size === 'small' ? 2 : 3) === 0
  if (step) belt++
  if (state === 'done' && !onLine && flights.length === 0 && f % 2 === 0 && tx < 32) tx++
  if (state !== 'done' && tx > 0 && f % 2 === 0) tx--
  if (sag > 0 && f % 4 === 0) sag--

  for (const it of items) {
    const s = ITEM[it.t]
    const w = s[0].length
    if (step && !it.drop) it.x++
    if (it.x >= g.beltEnd - w && !it.drop) {
      if (it.t === 'err') it.drop = 1
      else {
        it.gone = true
        flights.push({ t: it.t, sx: it.x + 2, sy: BELT_SURFACE - s.length, p: 0, slot: cargo.length + flights.length })
      }
    }
    if (it.drop) { if (f % 2 === 0) it.drop++; if (it.drop > 12) it.gone = true }
  }
  items = items.filter((i) => !i.gone)

  for (const fl of flights) {
    fl.p += 1 / 22
    if (fl.p >= 1) { fl.gone = true; cargo.push(fl.t); sag = 1 }
  }
  flights = flights.filter((fl) => !fl.gone)

  if (andonErr > 0) andonErr--
  moving = false
  if (walkT !== null) {
    const d = walkT - cx
    if (Math.abs(d) <= 0.5) { cx = walkT; walkT = null } else { cx += Math.sign(d) * 0.5; moving = true }
  }
  if (ctlT > 0) {
    ctlT--
    if (ctlT === 0 && state !== 'done') say('Back to my station')
  } else if (state === 'done' && !onBelt) {
    if (roamWait > 0) roamWait--
    else if (Math.abs(cx - roamT) < 1) {
      roamWait = 60 + Math.floor(Math.random() * 120)
      roamT = Math.floor(Math.random() * Math.max(10, g.maxX - 5))
      if (Math.random() < 0.35) hop(-0.7)
    } else if (f % 3 === 0) { cx += cx < roamT ? 1 : -1; moving = true }
  } else if (Math.round(cx) !== HOME && f % 2 === 0) { cx += cx > HOME ? -1 : 1; moving = true }

  if (onBelt && step) cx += 1
  if (onBelt && cx >= g.maxX) { cx = g.maxX; walkT = null; onBelt = false; vy = -0.5; noLand = 25; say('The belt pushed me!') }
  if (onBelt && !overBelt(cx)) onBelt = false
  if (noLand > 0) noLand--
  if (!onBelt) {
    vy += 0.08
    let ny = cy + vy
    if (vy >= 0 && !noLand && overBelt(cx) && cy <= BELT_Y && ny >= BELT_Y) { ny = BELT_Y; vy = 0; onBelt = true; say('Free ride!') }
    if (ny >= GROUND) { ny = GROUND; vy = 0 }
    cy = ny
  } else { cy = BELT_Y; vy = 0 }

  if (!emo && state !== 'stop' && Math.random() < 1 / 500) emo = { s: Math.random() < 0.6 ? NOTE : HEART, t: 50 }
  if (emo) { emo.t--; if (emo.t <= 0) emo = null }
  if (blinkT > 0) blinkT--
  else if (Math.random() < 1 / 200) blinkT = 6
  if (arm > 0) arm--
}

function bodyRows(up, blink) {
  const r0 = '..OOOOOOOOOO..'
  let r1 = blink ? '..OOOOOOOOOO..' : '..OOKOOOOKOO..'
  let r2 = '..OOKOOOOKOO..'
  let a = r0
  if (up) { a = 'O' + r0.slice(1, 13) + 'O'; r1 = 'O' + r1.slice(1, 13) + 'O' } else r2 = 'OO' + r2.slice(2, 12) + 'OO'
  return [a, r1, r2, '..OOOOOOOOOO..', '..OOOOOOOOOO..']
}

// Draws the visible slice of the world, rows [WORLD_BOTTOM - H, WORLD_BOTTOM), into a pixel buffer.
function drawScene(H) {
  const TOP = WORLD_BOTTOM - H
  const buf = new Uint32Array(W * H).fill(SKY)
  const px = (x, y, col) => {
    x = Math.round(x); y = Math.round(y)
    const yy = y - TOP
    if (x < 0 || x >= W || yy < 0 || yy >= H) return
    buf[yy * W + x] = col
  }
  const spr = (rows, x, y) => {
    rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.') px(x + i, y + j, P[row[i]]) })
  }
  const g = geo()

  if (g.truckX + tx < W) {
    spr(TRUCK.slice(0, 9), g.truckX + tx, 20 + sag)
    spr(TRUCK.slice(9), g.truckX + tx, 29)
    cargo.forEach((t, i) => { const [x, y] = slotXY(i); spr(MINI[t], x, y) })
  }

  for (let y = 23; y < BELT_SURFACE; y++) px(g.andonX, y, 0x6b6b66)
  let lamp = 0x3b9d4a
  if (andonErr > 0) lamp = f % 16 < 8 ? 0xe24b4a : 0x501313
  else if (state === 'stop') lamp = f % 40 < 20 ? 0xef9f27 : 0x633806
  else if (state === 'done') lamp = 0x378add
  for (let i = -1; i <= 1; i++) for (let j = 20; j <= 22; j++) px(g.andonX + i, j, lamp)

  for (let x = 16; x <= g.beltEnd; x++) {
    const q = (((x - belt) % 6) + 6) % 6
    px(x, BELT_SURFACE, q === 0 ? 0x5a5d65 : 0x2f3136)
    const m = (((x - belt) % 5) + 5) % 5
    px(x, BELT_SURFACE + 1, m > 0 && m < 4 ? 0x6b6b66 : 0x25272b)
  }
  for (const lx of [20, Math.round((16 + g.beltEnd) / 2), g.beltEnd - 6]) {
    for (let y = BELT_SURFACE + 2; y < FLOOR; y++) { px(lx, y, 0x4a4a46); px(lx + 1, y, 0x4a4a46) }
  }

  for (const it of items) { const s = ITEM[it.t]; spr(s, it.x, BELT_SURFACE - s.length + Math.min(it.drop, 7)) }
  for (const fl of flights) {
    const [tx2, ty2] = slotXY(fl.slot)
    const x = fl.sx + (tx2 - fl.sx) * fl.p
    const y = fl.sy + (ty2 - fl.sy) * fl.p - 5 * Math.sin(Math.PI * fl.p)
    spr(fl.p < 0.35 ? ITEM[fl.t].slice(0, 4).map((r) => r.slice(0, 6)) : MINI[fl.t], x, y)
  }

  for (let x = 0; x < W; x++) for (let y = FLOOR; y < FLOOR + 2; y++) px(x, y, (x + y) % 6 < 3 ? 0xf2c230 : 0x1a1a1a)

  const asking = state === 'stop'
  const done = state === 'done'
  const X = Math.round(cx)
  const Yt = Math.round(cy)
  const up = arm > 0 || done || (asking && f % 24 < 12)
  spr(HAT, X, Yt)
  spr(bodyRows(up, blinkT > 0), X, Yt + 3)
  spr(moving && Math.floor(f / 8) % 2 ? LEG_B : LEG_A, X, Yt + 8)
  if (emo) { const r = Math.floor((50 - emo.t) / 12); if (emo.t > 12 || emo.t % 6 < 4) spr(emo.s, X + 14, Yt + 1 - r) }
  if (done) {
    for (let y = Yt - 1; y <= Yt + 4; y++) px(X + 13, y, 0xcfcfcf)
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 4; i++) {
        const flutter = i > 1 && Math.floor(f / 8) % 2 ? 1 : 0
        px(X + 14 + i, Yt - 1 + j + flutter, (i + j) % 2 ? 0x111111 : 0xf4f4f0)
      }
    }
  }
  return { buf, X }
}

function toBase64(u32) {
  const bytes = new Uint8Array(u32.buffer)
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

// The character for a 2x3 sextant pattern. Bits, 1 = foreground:
//   1  2
//   4  8
//  16 32
function sextantChar(v) {
  if (v === 0) return 0x20
  if (v === 63) return 0x2588
  if (v === 21) return 0x258c
  if (v === 42) return 0x2590
  return 0x1fb00 + v - 1 - (v > 21 ? 1 : 0) - (v > 42 ? 1 : 0)
}

// Turns one cell's pixels into a character, a foreground and a background.
// A cell holds two colors at most: the commonest is the background, the next the foreground.
function cellOf(colors, bits) {
  const count = new Map()
  for (const c of colors) count.set(c, (count.get(c) || 0) + 1)
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1])
  const bg = ranked[0][0]
  const fg = ranked.length > 1 ? ranked[1][0] : bg
  let v = 0
  colors.forEach((c, k) => { if (c !== bg) v |= bits[k] })
  return [v, fg, bg]
}

function buildCells(cols, rows) {
  const { px: sx, py: sy } = SIZES[size]
  const { buf, X } = drawScene(rows * sy)
  const cells = new Uint32Array(rows * cols * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3
      if (sy === 2) {
        cells[i] = HALF_BLOCK
        cells[i + 1] = buf[2 * r * W + c]
        cells[i + 2] = buf[(2 * r + 1) * W + c]
      } else {
        const colors = []
        for (let j = 0; j < 3; j++) for (let k = 0; k < 2; k++) colors.push(buf[(3 * r + j) * W + 2 * c + k])
        const [v, fg, bg] = cellOf(colors, [1, 2, 4, 8, 16, 32])
        cells[i] = sextantChar(v)
        cells[i + 1] = fg
        cells[i + 2] = bg
      }
    }
  }
  // The speech bubble sits on the top row, just right of Clawd, so it never covers him.
  const text = ' ' + msg + ' '
  const [fg, bg] = BUBBLE[mood] || BUBBLE.normal
  const col = Math.max(0, Math.min(cols - text.length, Math.ceil((X + (state === 'done' ? 19 : 15)) / sx)))
  for (let k = 0; k < text.length; k++) {
    const i = (col + k) * 3
    cells[i] = text.codePointAt(k)
    cells[i + 1] = fg
    cells[i + 2] = bg
  }
  return toBase64(cells)
}

function statusLine() {
  const n = cargo.length
  const what = ctlT > 0 ? 'your turn' : state === 'run' ? 'line running' : state === 'stop' ? 'line stopped, waiting for you' : 'shipment on its way'
  return '· ' + n + (n === 1 ? ' box' : ' boxes') + ' · ' + what
}

// If a hook fails before it reached next(), let the event continue untouched.
const passThrough = async ($, e, next) => { if (!next.called) return next(e) }

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cargo', description: 'Turn the Cargo Belt on or off' })
    await $.command.register({ name: 'cargo-size', description: 'Switch the Cargo Belt between small and big pixels' })
    const saved = await $.store.get('enabled')
    if (typeof saved === 'boolean') enabled = saved
    const savedSize = await $.store.get('size')
    if (savedSize === 'small' || savedSize === 'big') size = savedSize
    lastTick = Date.now()
    $.clock.every(40, () => {
      const now = Date.now()
      acc += Math.min(now - lastTick, 200)
      lastTick = now
      const vis = visible()
      if (vis) {
        while (acc >= TICK_MS) { tick(); acc -= TICK_MS }
      } else acc = 0
      if (vis || wasVisible) $.ui.invalidate('ui.render')
      wasVisible = vis
    })
    return next(e)
  })

  on('command.run', { command: 'cargo-size' }, async ($) => {
    size = size === 'small' ? 'big' : 'small'
    await $.store.set('size', size)
    $.ui.invalidate('ui.render')
    return { text: size === 'small' ? 'Cargo Belt: small pixels.' : 'Cargo Belt: big pixels.' }
  })

  on('command.run', { command: 'cargo' }, async ($) => {
    enabled = !enabled
    await $.store.set('enabled', enabled)
    $.ui.invalidate('ui.render')
    return { text: enabled ? 'Cargo Belt is on.' : 'Cargo Belt is off.' }
  })

  on('turn.start', async ($, e, next) => {
    working = true
    if (state === 'done') { state = 'run'; cargo = []; tx = 32 }
    say('Shift started')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    working = false
    if (state === 'stop') state = 'run'
    ev('done')
    lingerUntil = Date.now() + LINGER_MS
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = e.tool || e.name || ''
    const input = e.input || {}
    if (tool === 'AskUserQuestion') {
      ev('ask')
      try { return await next(e) } finally { ev('ok') }
    }
    ev(kindOf(tool), labelOf(tool, input))
    let result
    try {
      result = await next(e)
    } catch (err) {
      ev('err')
      throw err
    }
    if (state === 'stop') ev('ok')
    if (result && (result.isError || result.is_error || result.deny || result.error)) ev('err')
    return result
  }).catch(passThrough)

  on('tool.check', async ($, e, next) => {
    const decision = await next(e)
    const d = typeof decision === 'string' ? decision : decision && decision.decision
    if (d === 'ask') ev('ask')
    return decision
  }).catch(passThrough)

  on('agent.spawn', async ($, e, next) => {
    say('A helper joined the line!')
    emo = { s: NOTE, t: 50 }
    return next(e)
  }).catch(passThrough)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.isWorking && enabled) working = true
    if (!visible()) return next(e)
    try {
      const { Box, Text, Button, Raster } = $.ui.resolve(e)
      const { rows, px: sx } = SIZES[size]
      const maxRows = (e.props && e.props.maxRows) || 16
      if (e.surface !== 'terminal' || !Raster || maxRows < rows + 1) {
        return Text({ dimColor: true, children: ['Cargo Belt ' + statusLine()] })
      }
      const cols = Math.max(Math.ceil(70 / sx), Math.min((e.props && e.props.bodyColumns) || 136, 200))
      W = Math.min(cols * sx, 300)
      const shown = Math.ceil(W / sx)
      const key = (k, label, hk) => Button({ key: k, label, hotkey: hk, plain: true, dimColor: true, onPress: () => act(hk) })
      return Box({
        flexDirection: 'column',
        children: [
          Raster({ key: 'belt', columns: shown, rows, cells: buildCells(shown, rows) }),
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ dimColor: true, children: [statusLine()] }),
              key('jump', 'jump', 'w'),
              key('left', 'left', 'a'),
              key('right', 'right', 'd'),
              key('down', 'get down', 's'),
              key('drop', 'drop a box', 'e'),
            ],
          }),
        ],
      })
    } catch {
      return next(e)
    }
  })
}
