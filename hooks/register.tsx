import type { Register } from 'claude-code'

import type { Task, TaskStatus } from '../types'

// The current task list, kept for the session so a reload keeps the bar.
const TASKS = { plugin: 'task-progress', key: 'tasks' } as const
// How far along, 0 to 100: finished steps set a floor, Claude adds the rest.
const PERCENT = { plugin: 'task-progress', key: 'percent' } as const
// When Claude expects to be done, in ms since the epoch; 0 for no estimate.
const ETA_AT = { plugin: 'task-progress', key: 'etaAt' } as const

// The tool Claude calls to move the bar.
const TOOL = 'mcp__task-progress__progress'

// The bar's colour.
const COLOR = '#D97757'

// The space between the bar and the text under it, in the app.
const TEXT_GAP = 'md'

// Until every step is done, small updates stop just short of a full bar.
const CAP = 99

type Loose = Record<string, unknown>

const isStatus = (s: unknown): s is TaskStatus =>
  s === 'pending' || s === 'in_progress' || s === 'completed'

const clamp = (n: number, max = 100) => Math.min(max, Math.max(0, n))
const floorOf = (list: Task[]) =>
  list.length === 0 ? 0 : (list.filter(t => t.status === 'completed').length / list.length) * 100
const allDone = (list: Task[]) => list.length > 0 && list.every(t => t.status === 'completed')

// The tool's description: all Claude is told about the bar.
const GUIDE = [
  "Moves the thin progress bar above the user's prompt, which shows how far along the current request is (0-100%).",
  'Call it after each small piece of work: `add` takes percentage points of the whole request, sized to the piece (+0.2 for a tiny step, +1, +3, +5 for bigger ones).',
  'Send that call in the same message as your next tool call, never in a message of its own, so it costs no extra round trip.',
  'Finishing a step of your task list moves the bar up on its own; use `set` only to correct it. Skip it for one-line answers.',
  'ETA (required for any request that takes more than a couple of tool calls): in the same message as your first tool call, pass `eta_seconds`, your honest best guess of the seconds left until the whole request is done; a countdown shows under the bar.',
  'Whenever your guess changes, pass a new `eta_seconds` (longer or shorter) counted from now.',
  'The ETA only informs the user: it is not a deadline. Never rush, skip checks or cut corners to meet it. Do the work properly and update the ETA instead.',
].join('\n')

// Reminders the model reads after a tool's result, so every Claude keeps the
// bar and the ETA up to date without being told.
const NUDGE = {
  noEta: `Progress bar: there is no ETA yet. In your next tool-call message, also call \`${TOOL}\` with \`eta_seconds\`: your honest best guess of the seconds left for the whole request. Do not rush to meet it; revise it whenever your guess changes.`,
  noBar: `Progress bar: this request is taking several steps. In your next tool-call message, also call \`${TOOL}\` with \`add\` for the work done so far and \`eta_seconds\` for an honest guess of the time left.`,
  stale: `Progress bar: it has not moved for several actions. In your next tool-call message, also call \`${TOOL}\` with \`add\` for the work done since, and a new \`eta_seconds\` if your guess changed.`,
  expired: `Progress bar: the ETA you gave has passed. In your next tool-call message, also call \`${TOOL}\` with a new honest \`eta_seconds\` for the time left. Keep doing the work properly; do not rush.`,
}

// How many other tool calls may pass before a reminder.
const STALE_AFTER = 4
const NO_BAR_AFTER = 3
const NO_ETA_AFTER = 2

// "2m 05s left", or a note once the estimate has passed.
function etaText(msLeft: number): string {
  if (msLeft <= 0) return 'taking a little longer than expected'
  const s = Math.ceil(msLeft / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `about ${h}h ${pad(m)}m left`
  if (m > 0) return `about ${m}m ${pad(sec)}s left`
  return `about ${sec}s left`
}

// The desktop app's plan tool: { items } replaces the list; { advance },
// { done: [n] } and { start: n } (1-based) move through it.
function applyPlan(list: Task[], args: Loose): Task[] {
  if (Array.isArray(args.items)) {
    return args.items.map((it: unknown, i: number) => {
      const item = (it ?? {}) as Loose
      return {
        id: String(i + 1),
        content: String(item.content ?? `Step ${i + 1}`),
        status: isStatus(item.status) ? item.status : 'pending',
      }
    })
  }

  let next = list.map(t => ({ ...t }))

  if (args.advance === true) {
    const current = next.find(t => t.status === 'in_progress')
    if (current) current.status = 'completed'
    const pending = next.find(t => t.status === 'pending')
    if (pending) pending.status = 'in_progress'
  }

  if (Array.isArray(args.done)) {
    for (const n of args.done) {
      const t = next[Number(n) - 1]
      if (t) t.status = 'completed'
    }
  }

  if (typeof args.start === 'number') {
    next = next.map(t => (t.status === 'in_progress' ? { ...t, status: 'pending' } : t))
    const t = next[args.start - 1]
    if (t) t.status = 'in_progress'
  }

  return next
}

export const register: Register = on => {
  // Whether a countdown is showing, so the timer redraws only then.
  let isCounting = false
  // Tool calls since Claude last moved the bar, and in this request.
  let sinceUpdate = 0
  let thisRequest = 0
  // The ETA already reminded about once it passed, and whether the
  // no-bar reminder went out this request.
  let remindedExpiredAt = 0
  let remindedNoBar = false

  on('session.start', async ($, e, next) => {
    const { value: etaAt = 0 } = await $.state.get(ETA_AT)
    isCounting = etaAt > 0
    // Ticks the countdown once a second while there is one.
    $.clock.every(1000, () => {
      if (isCounting) $.ui.invalidate('ui.render')
    })

    await $.tool.register({
      name: 'progress',
      description: GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          add: {
            type: 'number',
            description: 'Percentage points to add, may be fractional, e.g. 0.2, 1, 3, 5.',
          },
          set: { type: 'number', description: 'Set the bar to this percent, 0 to 100.' },
          eta_seconds: {
            type: 'number',
            description:
              'Your honest best guess of the seconds left until the whole request is done, counted from now. Send a new one whenever your guess changes.',
          },
        },
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Claude's own progress updates.
    if (e.tool === TOOL) {
      const args = e as unknown as Loose
      const { value: list = [] } = await $.state.get(TASKS)
      const { value: now = 0 } = await $.state.get(PERCENT)
      const max = allDone(list) ? 100 : CAP
      let percent = now
      if (typeof args.set === 'number' && Number.isFinite(args.set)) percent = clamp(args.set, max)
      if (typeof args.add === 'number' && Number.isFinite(args.add)) {
        percent = clamp(percent + args.add, max)
      }
      await $.state.set(PERCENT, percent)
      sinceUpdate = 0

      let eta = ''
      if (typeof args.eta_seconds === 'number' && Number.isFinite(args.eta_seconds)) {
        const seconds = Math.max(0, args.eta_seconds)
        await $.state.set(ETA_AT, (await $.clock.now()) + seconds * 1000)
        isCounting = true
        eta = `, ETA ${Math.round(seconds)}s`
      }
      return { result: `Progress: ${Math.round(percent * 10) / 10}%${eta}` }
    }

    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    if (result.isError) return result

    const args = e as unknown as Loose
    const out = (result.result ?? {}) as Loose
    const { value: list = [] } = await $.state.get(TASKS)
    let changed: Task[] | null = null
    let isNewList = false

    switch (e.tool) {
      // Claude Code desktop app's task list.
      case 'mcp__ccd_turn__update_plan':
        changed = applyPlan(list, args)
        isNewList = Array.isArray(args.items)
        break

      // The desktop app's wrap-up checks off the whole list.
      case 'mcp__ccd_turn__wrap_up':
        changed = list.map(t => ({ ...t, status: 'completed' as const }))
        break

      // Terminal: the classic todo list, sent whole each time.
      case 'TodoWrite':
        if (Array.isArray(args.todos)) {
          const todos = args.todos as Loose[]
          changed = todos.map((t, i) => ({
            id: String(i + 1),
            content: String(t.activeForm ?? t.content ?? ''),
            status: isStatus(t.status) ? t.status : 'pending',
          }))
        }
        break

      // Terminal: the task tools, one task at a time.
      case 'TaskCreate': {
        const task = (out.task ?? {}) as Loose
        if (typeof task.id === 'string') {
          const id = task.id
          changed = [
            ...list.filter(t => t.id !== id),
            { id, content: String(task.subject ?? args.subject ?? ''), status: 'pending' },
          ]
        }
        break
      }

      case 'TaskUpdate': {
        const id = String(args.taskId ?? '')
        changed =
          args.status === 'deleted'
            ? list.filter(t => t.id !== id)
            : list.map(t =>
                t.id === id
                  ? {
                      ...t,
                      content: String(args.subject ?? t.content),
                      status: isStatus(args.status) ? args.status : t.status,
                    }
                  : t,
              )
        break
      }
    }

    if (changed) {
      await $.state.set(TASKS, changed)
      // A new plan starts the bar over; otherwise finished steps only raise it.
      const { value: now = 0 } = await $.state.get(PERCENT)
      const floor = floorOf(changed)
      const percent = allDone(changed)
        ? 100
        : isNewList
          ? floor
          : clamp(Math.max(now, floor), CAP)
      await $.state.set(PERCENT, percent)
      // Everything done: the countdown has nothing left to count.
      if (percent >= 100) {
        await $.state.set(ETA_AT, 0)
        isCounting = false
      }
    }

    // Remind Claude to keep the bar and the ETA up to date.
    sinceUpdate += 1
    thisRequest += 1
    const { value: tasks = [] } = await $.state.get(TASKS)
    const { value: percent = 0 } = await $.state.get(PERCENT)
    const { value: etaAt = 0 } = await $.state.get(ETA_AT)
    const isActive = percent < 100 && (tasks.length > 0 || percent > 0)

    let nudge: string | null = null
    if (isActive) {
      // Not on the task list's own call: an ETA sent beside it in the same
      // message is handled just after, so wait one more call to see.
      if (etaAt === 0 && !isNewList && sinceUpdate >= NO_ETA_AFTER) {
        nudge = NUDGE.noEta
      } else if (etaAt > 0 && etaAt !== remindedExpiredAt && (await $.clock.now()) > etaAt) {
        nudge = NUDGE.expired
        remindedExpiredAt = etaAt
      } else if (sinceUpdate >= STALE_AFTER) {
        nudge = NUDGE.stale
      }
    } else if (percent <= 0 && !remindedNoBar && thisRequest >= NO_BAR_AFTER) {
      // Several steps in with no task list and no bar at all.
      nudge = NUDGE.noBar
      remindedNoBar = true
    }

    if (nudge === null) return result
    sinceUpdate = 0
    return { ...result, context: [...(result.context ?? []), nudge] }
  })

  // A new request clears a bar that already reached the end.
  on('prompt.submit', async ($, e, next) => {
    thisRequest = 0
    sinceUpdate = 0
    remindedNoBar = false
    const { value: list = [] } = await $.state.get(TASKS)
    const { value: percent = 0 } = await $.state.get(PERCENT)
    if (allDone(list) || percent >= 100) {
      await $.state.set(TASKS, [])
      await $.state.set(PERCENT, 0)
      await $.state.set(ETA_AT, 0)
      isCounting = false
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: list = [] } = await $.state.get(TASKS)
    const { value: percent = 0 } = await $.state.get(PERCENT)
    if (e.props.hasSurvey || (list.length === 0 && percent <= 0)) return next(e)

    const els = $.ui.resolve(e)
    const alt = `${Math.round(percent)}% done`

    // The countdown under the bar, while Claude has given an estimate.
    const { value: etaAt = 0 } = await $.state.get(ETA_AT)
    const isFinished = percent >= 100
    const eta = isFinished
      ? 'Finished'
      : etaAt > 0
        ? etaText(etaAt - (await $.clock.now()))
        : null

    // The step being worked on, shown at the right end of the line under the bar.
    const task = isFinished ? null : (list.find(t => t.status === 'in_progress')?.content ?? null)

    // The line under the bar: the countdown on the left, the task name on the right.
    const info =
      eta || task ? (
        <els.Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <els.Text dimColor wrap="truncate-end">
            {eta ?? ''}
          </els.Text>
          {task ? (
            <els.Box flexShrink={1}>
              <els.Text dimColor wrap="truncate-end">
                {task}
              </els.Text>
            </els.Box>
          ) : null}
        </els.Box>
      ) : null

    // A thin pill: only the filled part, round ends, nothing behind it.
    // The viewBox has no fixed size, so it stretches to the band's width and
    // keeps its shape, which keeps the ends round.
    // The terminal has no real Svg (its table hands back an empty stand-in).
    if (e.surface !== 'terminal' && 'Svg' in els) {
      const W = 1000
      const H = 4
      const fill = Math.max(H, Math.round((percent / 100) * W))
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
        `<rect x="0" y="0" width="${fill}" height="${H}" rx="${H / 2}" ry="${H / 2}" fill="${COLOR}"/>` +
        `</svg>`
      return (
        <els.Box flexDirection="column">
          <els.Svg source={source} alt={alt} />
          {/* A gap above the text drops it toward the bottom of the box. */}
          {info ? <els.Box marginTop={TEXT_GAP}>{info}</els.Box> : null}
        </els.Box>
      )
    }

    // The terminal has no Svg: a row of heavy line characters instead.
    const cells = Math.max(1, Math.round((percent / 100) * e.props.bodyColumns))
    return (
      <els.Box flexDirection="column">
        <els.Text color={COLOR}>{'━'.repeat(cells)}</els.Text>
        {info}
      </els.Box>
    )
  })
}
