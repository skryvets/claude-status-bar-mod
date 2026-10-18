import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionLimit, SessionPull, SessionSlice, SessionView } from '../types'

const HOUR = 3600000
const SPAN: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 168 * HOUR }
const NAME: Record<string, string> = { five_hour: 'Session', seven_day: 'Weekly' }
const BAR = 24
const ORDER = { used: 0, free: 1, buffer: 2 }
const GLYPH = { used: '█', free: '░', buffer: '▒' }
const LABEL: Record<string, string> = {
  'System prompt': 'system',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  'MCP server instructions': 'mcp info',
  'Memory files': 'memory',
  'Custom agents': 'agents',
  Messages: 'msgs',
  'Autocompact buffer': 'buffer',
}
// Palette follows context-bar by Hamza Zafar (github.com/hamzafer/claude-code-mods): /context's theme gives several rows the same grey
const PALETTE = ['#7aa2f7', '#7dcfff', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#73daca', '#c0caf5']
const ELAPSED = '#999999'
const MARK = '#333131'
const COMMAND = 'status-bar-mod'
const EMPTY: SessionView = {
  tokens: 0,
  percent: 0,
  model: '',
  effort: '',
  folder: '',
  branch: '',
  changed: 0,
  ahead: 0,
  behind: 0,
  isUnpublished: false,
  pull: null,
  slices: [],
  window: 0,
  limits: [],
  now: 0,
  isHidden: false,
}
const view = atom({ plugin: 'session', key: 'view' } as const, EMPTY)

const short = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1e6).toFixed(1)}M`

const left = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  const hours = Math.floor(minutes / 60)

  return hours >= 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : hours > 0
      ? `${hours}h ${minutes % 60}m`
      : `${minutes}m`
}

const heat = (percent: number) =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'

const cells = (percent: number) =>
  percent > 0 ? Math.min(BAR, Math.max(1, Math.round((percent / 100) * BAR))) : 0

const FREE = { kind: 'free', color: 'inactive' } as const
const BUFFER = { kind: 'buffer', color: 'inactive' } as const

// Sized in half cells: ▌ takes one colour as foreground and the next as background, so a cell holds two categories
const stack = (slices: SessionSlice[], window: number) => {
  let next = 0
  const parts = slices.map(slice => ({
    ...slice,
    label: LABEL[slice.name] ?? slice.name.toLowerCase(),
    color:
      slice.kind !== 'used'
        ? 'inactive'
        : slice.name === 'Messages'
          ? 'claude'
          : PALETTE[next++ % PALETTE.length]!,
  }))
  const used = parts.filter(part => part.kind === 'used')
  const sum = (list: number[]) => list.reduce((total, n) => total + n, 0)
  const tokens = (kind: SessionSlice['kind']) =>
    sum(slices.filter(slice => slice.kind === kind).map(slice => slice.tokens))
  const scale = (BAR * 2) / Math.max(window, tokens('used'))
  const quotas = used.map(part => part.tokens * scale)
  const sizes = quotas.map(Math.floor)
  // Whole cells in total: a half cell next to the free space leaves a gap in the terminal's background colour
  const filled = 2 * Math.max(used.length > 0 ? 1 : 0, Math.round(sum(quotas) / 2))

  const order = quotas
    .map((quota, i) => [quota - sizes[i]!, i] as const)
    .sort((a, b) => b[0] - a[0])

  for (let turn = 0; sum(sizes) < filled; turn++) {
    sizes[order[turn % order.length]![1]]!++
  }

  const buffer = Math.min(BAR * 2 - filled, 2 * Math.round((tokens('buffer') * scale) / 2))
  const halves = [
    ...used.flatMap((part, i) => Array<(typeof used)[number]>(sizes[i]!).fill(part)),
    ...Array<typeof FREE>(BAR * 2 - filled - buffer).fill(FREE),
    ...Array<typeof BUFFER>(buffer).fill(BUFFER),
  ]

  return {
    parts,
    cells: Array.from({ length: BAR }, (_, i) => {
      const [a, b] = [halves[i * 2]!, halves[i * 2 + 1]!]

      return a === b || a.kind !== 'used'
        ? { glyph: GLYPH[a.kind], color: a.color }
        : { glyph: '▌', color: a.color, ...(b.kind === 'used' && { backgroundColor: b.color }) }
    }),
  }
}

const untilReset = (limit: SessionLimit, now: number) =>
  limit.resetsAt ? Date.parse(limit.resetsAt) - now : 0

// Pace rules follow CodexBar's UsagePace.swift and UsagePaceText.swift, the marker its UsageProgressBar.swift (github.com/steipete/CodexBar)
const passed = (limit: SessionLimit, now: number) => {
  const span = SPAN[limit.kind]
  const remaining = untilReset(limit, now)

  return !span || remaining <= 0 || remaining > span ? null : ((span - remaining) / span) * 100
}

const pace = (limit: SessionLimit, now: number) => {
  const expected = passed(limit, now)

  if (expected === null) return null

  const remaining = untilReset(limit, now)
  const elapsed = SPAN[limit.kind]! - remaining
  const actual = Math.min(100, Math.max(0, limit.percentUsed))

  if (actual >= 100) return { verdict: 'limit reached', outlook: '', color: 'error' }
  if (expected < 3) return null

  const delta = actual - expected
  const runsOutIn = actual > 0 ? ((100 - actual) / actual) * elapsed : Infinity

  return {
    verdict:
      Math.abs(delta) <= 2
        ? 'on pace'
        : `${Math.round(Math.abs(delta))}% in ${delta > 0 ? 'deficit' : 'reserve'}`,
    outlook: runsOutIn >= remaining ? 'lasts until reset' : `runs out in ${left(runsOutIn)}`,
    color: delta > 12 ? 'error' : delta > 2 ? 'warning' : 'success',
  }
}

const PULL: Record<string, string> = { OPEN: 'success', MERGED: 'merged', CLOSED: 'error' }

// Reads `git status --porcelain=v2 --branch` (git-scm.com/docs/git-status#_porcelain_format_version_2)
const repo = (status: string, hasRemote: boolean) => {
  const lines = status.split('\n').filter(line => line !== '')
  const header = (name: string) =>
    lines.find(line => line.startsWith(`# branch.${name} `))?.slice(`# branch.${name} `.length)
  const head = header('head') ?? ''
  const [ahead = 0, behind = 0] = (header('ab') ?? '').split(' ').map(n => Math.abs(Number(n)))

  return {
    branch: head === '(detached)' ? '' : head,
    changed: lines.filter(line => !line.startsWith('#')).length,
    ahead,
    behind,
    isUnpublished: hasRemote && head !== '' && head !== '(detached)' && header('upstream') === undefined,
  }
}

// Kept out of sync: both ask the network, too slow for every measure
const review = async ($: EngineInterface, effort: string) => {
  const [gh] = await Promise.all([
    $.process
      .run(['gh', 'pr', 'view', '--json', 'number,state,headRefName'], { timeoutMs: 5000 })
      .catch(() => null),
    // No prompt can be answered here, so a remote that asks for a password fails at once
    $.process
      .run(['git', 'fetch', '--quiet'], { timeoutMs: 10000, env: { GIT_TERMINAL_PROMPT: '0' } })
      .catch(() => null),
  ])
  let pull: SessionPull | null = null

  try {
    const { number, state, headRefName } = JSON.parse(gh?.exitCode === 0 ? gh.stdout : 'null')

    pull = { branch: headRefName, number, state }
  } catch {}

  await update($, view, now => ({ ...now, pull }))
  await sync($, effort)
}

const sync = async ($: EngineInterface, effort: string) => {
  const [cwd, home, model, usage, now, git, remote, hidden] = await Promise.all([
    $.session.cwd(),
    $.env.get('HOME'),
    $.session.model(),
    $.session.usage({ breakdown: 'summary' }),
    $.clock.now(),
    $.process.run(['git', 'status', '--porcelain=v2', '--branch']).catch(() => null),
    $.process.run(['git', 'remote']).catch(() => null),
    $.store.get('hidden'),
  ])
  await update($, view, ({ pull }) => ({
    tokens: usage.context.tokens ?? usage.context.breakdown?.totalTokens ?? 0,
    percent: usage.context.percent ?? usage.context.breakdown?.percentage ?? 0,
    model,
    effort,
    folder: home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd,
    ...repo(git?.exitCode === 0 ? git.stdout : '', remote?.exitCode === 0 && remote.stdout.trim() !== ''),
    pull,
    slices: (usage.context.breakdown?.categories ?? [])
      .flatMap(({ name, tokens, kind }) =>
        kind === 'deferred' || tokens <= 0 ? [] : [{ name, tokens, kind }],
      )
      .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]),
    window: usage.context.breakdown?.rawMaxTokens ?? 0,
    limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) =>
      resetsAt ? { kind, percentUsed, resetsAt } : { kind, percentUsed },
    ),
    now,
    isHidden: hidden === true,
  }))
}

export const register: Register = on => {
  let effort = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show or hide the status bar' })
    await sync($, effort)
    await review($, effort)
    $.clock.every(60000, async () => {
      await sync($, effort)
      await review($, effort)
    })

    return next(e)
  })

  // /clear and resume go on under a new session with empty state, and no session.start fires for them
  on('classic.SessionStart', async ($, e, next) => {
    await sync($, effort).catch(() => {})
    await review($, effort).catch(() => {})

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isHidden = (await $.store.get('hidden')) !== true

    await $.store.set('hidden', isHidden)
    await sync($, effort)

    return { text: isHidden ? 'Status bar hidden' : 'Status bar shown' }
  })

  on('session.measure', async ($, e, next) => {
    await sync($, effort)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      await sync($, effort).catch(() => {})
    }

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const asked = String(e.effort ?? '')

    if (e.agentId === undefined && asked !== effort) {
      effort = asked
      await sync($, effort)
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await sync($, effort)
      await review($, effort)
    }

    return next(e)
  })

  // Drawn above the prompt because the engine drops PromptHint while it shows a notice of its own ("paste again to expand")
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const now = await read($, view)

    if (e.props.hasSurvey || now.model === '' || now.isHidden) {
      return rest
    }

    const { Box, Text } = $.ui.resolve(e)
    const dot = <Text dimColor> · </Text>
    const row = (label: string, percent: number, color: string) => [
      <Text bold>{`${label}:`.padEnd(9)}</Text>,
      <Text color={color}>{'█'.repeat(cells(percent))}</Text>,
      <Text color="inactive">{'░'.repeat(BAR - cells(percent))}</Text>,
    ]

    const { parts, cells: bar } =
      now.window > 0 ? stack(now.slices, now.window) : { parts: [], cells: [] }
    const lines = 2 + now.limits.filter(limit => NAME[limit.kind]).length
    // TODO: confirm the band should pack tight below this rather than keep its blank rows and scroll - the engine caps it at half the terminal, the prompt included
    const gap = e.props.maxRows >= lines * 2 - 1 ? 1 : 0
    const paddingTop = e.props.maxRows >= lines * 2 ? 1 : 0

    return (
      <Box flexDirection="column" gap={gap} paddingTop={paddingTop} paddingLeft={2}>
        <Text mono wrap="truncate-end">
          <Text>{now.model}</Text>
          {now.effort !== '' && dot}
          {now.effort !== '' && <Text color="claude">{now.effort}</Text>}
          {dot}
          <Text dimColor>{now.folder}</Text>
          {now.branch !== '' && <Text color="suggestion">{` (${now.branch})`}</Text>}
          {now.changed > 0 && <Text color="warning">{` ±${now.changed}`}</Text>}
          {(now.ahead > 0 || now.isUnpublished) && (
            <Text color="success">{` ↑${now.ahead || ''}`}</Text>
          )}
          {now.behind > 0 && <Text color="error">{` ↓${now.behind}`}</Text>}
          {now.pull?.branch === now.branch && dot}
          {now.pull?.branch === now.branch && (
            <Text color={PULL[now.pull.state] ?? 'inactive'}>
              {`PR #${now.pull.number} ${now.pull.state.toLowerCase()}`}
            </Text>
          )}
        </Text>
        <Text mono wrap="truncate-end">
          {parts.length === 0
            ? row('Context', now.percent, heat(now.percent))
            : [
                <Text bold>{'Context: '}</Text>,
                ...bar.map(({ glyph, ...colors }) => <Text {...colors}>{glyph}</Text>),
              ]}
          <Text bold color={heat(now.percent)}>{` ${short(now.tokens)}`}</Text>
          <Text>{` (${now.percent}%)`}</Text>
          {/* TODO: confirm the legend is wanted - it is the only added text and is the first thing cut on a narrow terminal */}
          {parts
            .filter(part => part.kind !== 'free')
            .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.tokens - a.tokens)
            .map((part, i) => (
              <Text>
                {i === 0 ? dot : '  '}
                <Text color={part.color}>{part.kind === 'used' ? '■' : GLYPH[part.kind]}</Text>
                <Text dimColor>{` ${part.label}`}</Text>
              </Text>
            ))}
        </Text>
        {now.limits.flatMap(limit => {
          const name = NAME[limit.kind]

          if (!name) return []

          const at = pace(limit, now.now)
          const reset = untilReset(limit, now.now)
          const filled = Math.round(((passed(limit, now.now) ?? 0) / 100) * BAR)
          const mark = Math.min(BAR - 1, Math.max(0, Math.round((limit.percentUsed / 100) * BAR)))

          return [
            <Text mono wrap="truncate-end">
              <Text bold>{`${name}:`.padEnd(9)}</Text>
              {Array.from({ length: BAR }, (_, i) =>
                i === mark ? (
                  <Text color={MARK}>█</Text>
                ) : i < filled ? (
                  <Text color={ELAPSED}>█</Text>
                ) : (
                  <Text color="inactive">░</Text>
                ),
              )}
              <Text>{` ${Math.round(limit.percentUsed)}% used`}</Text>
              {at && dot}
              {at && <Text color={at.color}>{at.verdict}</Text>}
              {at && at.outlook !== '' && dot}
              {at && at.outlook !== '' && <Text color={at.color}>{at.outlook}</Text>}
              {reset > 0 && dot}
              {reset > 0 && <Text dimColor>{`resets in ${left(reset)}`}</Text>}
            </Text>,
          ]
        })}
        {rest}
      </Box>
    )
  })
}
