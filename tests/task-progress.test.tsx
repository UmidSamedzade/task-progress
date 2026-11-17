import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'task-progress',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 40,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'
const PROGRESS = 'mcp__task-progress__progress'

const ITEMS = [
  { content: 'Gather inputs', status: 'in_progress' },
  { content: 'Crunch numbers', status: 'pending' },
  { content: 'Wrap up', status: 'pending' },
]

// The fill width, out of 1000, the Svg's markup draws.
const fillOf = (source: unknown) => Number(/width="(\d+)" height/.exec(String(source))?.[1])

test('a new plan draws a thin bar with the step name on the right', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: ITEMS })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  // Nothing done yet: the bar is the smallest dot.
  expect(fillOf(svg?.props.source)).toBe(4)
  expect((await ui.find({ type: 'Text', text: /Gather inputs/ }))?.text).toBe('Gather inputs')
  await ui.unmount()
})

test('small steps add up, and stop short of full until the end', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: ITEMS })

  await $.tool.call({ tool: PROGRESS, add: 0.2 })
  await $.tool.call({ tool: PROGRESS, add: 5 })
  const r = await $.tool.call({ tool: PROGRESS, add: 3 })
  expect(r.result).toBe('Progress: 8.2%')

  const big = await $.tool.call({ tool: PROGRESS, add: 500 })
  expect(big.result).toBe('Progress: 99%')
})

test('finishing a step raises the bar to at least its share', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: ITEMS })
  await $.tool.call({ tool: PLAN, advance: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(fillOf((await ui.find({ type: 'Svg' }))?.props.source)).toBe(333)
  expect((await ui.find({ type: 'Text', text: /Crunch numbers/ }))?.text).toBe('Crunch numbers')
  await ui.unmount()
})

test('an ETA shows a countdown on the left', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  // The clock stands still, so the countdown reads exactly what was set.
  on('clock.now', () => ({ value: 1_000_000 }))
  await $.tool.call({ tool: PLAN, items: ITEMS })
  const r = await $.tool.call({ tool: PROGRESS, add: 1, eta_seconds: 90 })
  expect(r.result).toBe('Progress: 1%, ETA 90s')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /left/ }))?.text).toBe('about 1m 30s left')
    await ui.unmount()
  }
})

test('when it is over: a full bar, Finished on the left, nothing on the right', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: ITEMS })
  await $.tool.call({ tool: PROGRESS, eta_seconds: 30 })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(fillOf((await ui.find({ type: 'Svg' }))?.props.source)).toBe(1000)
  expect((await ui.find({ type: 'Text', text: /Finished/ }))?.text).toBe('Finished')
  expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /left|Wrap up/ })).toBeUndefined()
  await ui.unmount()
})

test('the next message clears a finished bar', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => e)
  await $.tool.call({ tool: PLAN, items: ITEMS })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })
  await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('the terminal draws the bar as a line of characters', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: ITEMS })
  await $.tool.call({ tool: PROGRESS, set: 50 })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /━/ }))?.text).toBe('━'.repeat(20))
  await ui.unmount()
})

// The reminder Claude reads after a tool's result, if any.
const nudgeOf = (r: { context?: readonly string[] }) => (r.context ?? []).join('\n')

test('a new task list with no ETA reminds Claude to set one', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 1_000_000 }))
  const r = await $.tool.call({ tool: PLAN, items: ITEMS })
  expect(nudgeOf(r)).toMatch(/no ETA yet/)

  // Once an ETA is set, the next call carries no reminder.
  await $.tool.call({ tool: PROGRESS, eta_seconds: 60 })
  const quiet = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(nudgeOf(quiet)).toBe('')
})

test('a bar that stops moving gets a reminder', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 1_000_000 }))
  await $.tool.call({ tool: PLAN, items: ITEMS })
  await $.tool.call({ tool: PROGRESS, eta_seconds: 600 })

  const calls = []
  for (let i = 0; i < 4; i++) calls.push(nudgeOf(await $.tool.call({ tool: 'Bash', command: 'ls' })))
  expect(calls.slice(0, 3)).toEqual(['', '', ''])
  expect(calls[3]).toMatch(/has not moved/)
})

test('an ETA that ran out asks for a new one, once', async ($, on) => {
  let now = 1_000_000
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: now }))
  await $.tool.call({ tool: PLAN, items: ITEMS })
  await $.tool.call({ tool: PROGRESS, eta_seconds: 10 })

  now += 20_000
  expect(nudgeOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toMatch(/ETA you gave has passed/)
  expect(nudgeOf(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toBe('')
})

test('several steps with no task list and no bar get one reminder', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const calls = []
  for (let i = 0; i < 5; i++) calls.push(nudgeOf(await $.tool.call({ tool: 'Bash', command: 'ls' })))
  expect(calls.filter(c => /taking several steps/.test(c)).length).toBe(1)
})
