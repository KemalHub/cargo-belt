// Runs the Cargo Belt mod outside Claude Code, with a fake mods API and a fake clock.
// Used by tools/preview.mjs to play the scene in your terminal without Claude.

let fakeNow = 1_000_000
Date.now = () => fakeNow

const { register } = await import('../plugin/hooks/register.js')

const hooks = []
register((name, a, b) => {
  hooks.push({ name, matcher: b ? a : null, fn: b || a })
  return { catch() {} }
})

let timer = null
const el = (type) => (props) => ({ type, props })
const api = {
  command: { register: async () => {} },
  store: { get: async () => undefined, set: async () => {} },
  clock: { every: (_ms, fn) => { timer = fn } },
  ui: {
    invalidate() {},
    resolve: () => ({ Box: el('Box'), Text: el('Text'), Button: el('Button'), Raster: el('Raster') }),
  },
}

export async function fire(name, e = {}, nextResult = {}) {
  let out
  for (const h of hooks) {
    if (h.name !== name) continue
    if (h.matcher && !Object.entries(h.matcher).every(([k, v]) => e[k] === v)) continue
    out = await h.fn(api, e, async () => nextResult)
  }
  return out
}

// Advances the fake clock by ms and runs the mod's timer once.
export function step(ms) {
  fakeNow += ms
  if (timer) timer()
}

// Returns the band as { columns, rows, cells: Uint32Array, status }.
export async function frame(columns = 136) {
  const tree = await fire('ui.render', {
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { bodyColumns: columns, maxRows: 16, isWorking: true },
  }, null)
  if (!tree || tree.type !== 'Box') return null
  const r = tree.props.children[0].props
  const bytes = Buffer.from(r.cells, 'base64')
  const cells = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
  const status = tree.props.children[1].props.children[0].props.children[0]
  return { columns: r.columns, rows: r.rows, cells, status }
}

// A scripted shift: [event, args, ticks to wait after it].
export const SCRIPT = [
  ['tool.call', { tool: 'Read', input: { file_path: 'README.md' } }, 70],
  ['tool.call', { tool: 'Grep', input: { pattern: 'TODO' } }, 70],
  ['tool.call', { tool: 'Edit', input: { file_path: 'register.js' } }, 80],
  ['tool.call', { tool: 'Bash', input: { command: 'npm test' } }, 90],
  ['tool.call', { tool: 'Read', input: { file_path: 'plan.md' } }, 60],
  ['tool.call', { tool: 'Write', input: { file_path: 'main.ts' } }, 70],
  ['fail', { tool: 'Bash', input: { command: 'npm run build' } }, 90],
  ['tool.call', { tool: 'Read', input: { file_path: 'config.json' } }, 60],
  ['tool.check', {}, 140],
  ['tool.call', { tool: 'Edit', input: { file_path: 'config.json' } }, 70],
  ['tool.call', { tool: 'Bash', input: { command: 'npm test' } }, 80],
  ['tool.call', { tool: 'Read', input: { file_path: 'CHANGELOG.md' } }, 220],
  ['turn.complete', {}, 320],
]

export async function play(name, args) {
  if (name === 'fail') return fire('tool.call', args, { isError: true })
  if (name === 'tool.check') return fire('tool.check', args, { decision: 'ask' })
  if (name === 'tool.call') return fire('tool.call', args, {})
  return fire(name, args)
}

await fire('session.start')
