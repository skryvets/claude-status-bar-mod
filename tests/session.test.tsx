import { expect, mock, test } from 'claude-code/testing'
import type { ContextCategory, On, SessionRateLimit } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 115,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const session = (
  on: On,
  rateLimits: SessionRateLimit[],
  tokens: () => number | undefined = () => 46100,
  categories?: ContextCategory[],
  host: (e: { argv: readonly string[]; init?: { env?: Record<string, string> } }) => Record<string, string> = () => ({ 'git status': '# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n' }),
) => {
  const estimate = (categories ?? []).reduce(
    (sum, { tokens, kind }) => (kind === 'used' ? sum + tokens : sum),
    0,
  )

  mock.clock(on, { now: Date.parse('2026-10-10T10:00:00Z') })
  mock.env(on, { HOME: '/Users/me' })
  mock.store(on)
  on('session.cwd', () => ({ value: '/Users/me/Code/app' }))
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('process.run', (_, e) => {
    const stdout = host(e)[e.argv.slice(0, 2).join(' ')]

    return {
      value: {
        exitCode: stdout === undefined ? 1 : 0,
        stdout: stdout ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        ...(tokens() !== undefined && { tokens: tokens()!, percent: 23 }),
        window: 200000,
        ...(categories && {
          breakdown: {
            categories,
            totalTokens: estimate,
            maxTokens: 200000,
            rawMaxTokens: 200000,
            autocompactSource: 'model-default',
            percentage: Math.round(estimate / 2000),
            gridRows: [],
            model: 'opus',
            memoryFiles: [],
            mcpTools: [],
            agents: [],
            isAutoCompactEnabled: true,
            apiUsage: null,
          },
        }),
      },
      rateLimits,
    },
  }))
  on('session.measure', (_, e) => ({ changed: [...e.changed] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>band below</Text>
  })
}

test('context, model, folder and limit pace are drawn above the prompt', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session', surface, ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

    for (const part of [
      'Opus 5.5',
      '~/Code/app',
      '(main)',
      'Context: ',
      `${'█'.repeat(6)}${'░'.repeat(18)}`,
      '46.1K',
      '(23%)',
      `Session: ${'█'.repeat(16)}█${'░'.repeat(7)} 66% used`,
      '7% in reserve',
      'lasts until reset',
      'resets in 1h 22m',
      `Weekly:  ${'█'.repeat(10)}░░░░█${'░'.repeat(9)} 60% used`,
      '17% in deficit',
      'runs out in 2d 0h',
      'resets in 4d 0h',
      'band below',
    ]) {
      expect(texts).toContain(part)
    }

    await ui.unmount()
  }
})

test('every band line keeps a monospaced face so the bars line up on desktop', async ($, on) => {
  session(
    on,
    [
      { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-10T11:22:00Z' },
      { kind: 'seven_day', percentUsed: 3, resetsAt: '2026-10-14T10:00:00Z' },
    ],
    () => 46100,
    [
      { name: 'Messages', tokens: 30000, kind: 'used', color: 'inactive', isDeferred: false },
      { name: 'System tools', tokens: 16100, kind: 'used', color: 'inactive', isDeferred: false },
      { name: 'Free space', tokens: 120000, kind: 'free', color: 'inactive', isDeferred: false },
      { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer', color: 'inactive', isDeferred: false },
    ],
  )
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'desktop', ...BAND })
  const lines = (await ui.findAll({ type: 'Text' })).filter(found => found.props.wrap === 'truncate-end')

  expect(lines.map(found => found.text.split(':')[0])).toEqual([
    'Opus 5.5 · ~/Code/app (main)',
    'Context',
    'Session',
    'Weekly',
  ])
  expect(lines.every(found => found.props.mono === true)).toBe(true)
  await ui.unmount()
})

test('pace is held back until 3% of the window has passed', async ($, on) => {
  session(on, [{ kind: 'seven_day', percentUsed: 4, resetsAt: '2026-10-17T09:00:00Z' }])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain(`Weekly:  ░█${'░'.repeat(22)} 4% used`)
  expect(texts).toContain('resets in 6d 23h')
  expect(texts).not.toContain('pace')
  expect(texts).not.toContain('deficit')
  expect(texts).not.toContain('runs out')
})

test('on pace can still forecast running out, as CodexBar does', async ($, on) => {
  session(on, [{ kind: 'seven_day', percentUsed: 27, resetsAt: '2026-10-15T14:00:00Z' }])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('on pace')
  expect(texts).toContain('runs out in 4d 22h')
  expect(texts).toContain('resets in 5d 4h')
})

test('context is read again after a compaction', async ($, on) => {
  let tokens = 201800

  session(on, [], () => tokens)
  on('session.compact', (_, e) => ({ messages: [...e.messages] }))
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
  tokens = 51600
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('51.6K')
  expect(texts).not.toContain('201.8K')
})

test('context is drawn as one bar stacked by what fills the window', async ($, on) => {
  const row = (name: string, tokens: number, kind: ContextCategory['kind'] = 'used') => ({
    name,
    tokens,
    kind,
    color: 'inactive',
    isDeferred: kind === 'deferred',
  })

  session(on, [], () => 46100, [
    row('System prompt', 3000),
    row('System tools', 16000),
    row('MCP tools (deferred)', 40000, 'deferred'),
    row('Skills', 0),
    row('Messages', 27100),
    row('Autocompact buffer', 33000, 'buffer'),
    row('Free space', 120900, 'free'),
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toContain(`Context: ▌█▌███${'░'.repeat(14)}▒▒▒▒ 46.1K (23%) · ■ msgs  ■ tools  ■ system  ▒ buffer`)
  const halves = (await ui.findAll({ type: 'Text', text: '▌' })).filter(found => found.text === '▌')

  expect(halves.map(found => found.props.backgroundColor)).toEqual(['#7dcfff', 'claude'])
  expect(texts.join('|')).not.toContain('deferred')
  expect(texts.join('|')).not.toContain('skills')
})

test('a fresh session shows the estimated context until the first response', async ($, on) => {
  const row = (name: string, tokens: number, kind: ContextCategory['kind'] = 'used') => ({
    name,
    tokens,
    kind,
    color: 'inactive',
    isDeferred: false,
  })

  session(on, [], () => undefined, [
    row('System prompt', 4000),
    row('System tools', 18000),
    row('Skills', 0),
    row('Messages', 0),
    row('Autocompact buffer', 33000, 'buffer'),
    row('Free space', 145000, 'free'),
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toContain(`Context: ▌██${'░'.repeat(17)}▒▒▒▒ 22.0K (11%) · ■ tools  ■ system  ▒ buffer`)
})

test('the band gives up the blank row above before the ones between lines', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 60, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  for (const [maxRows, gap, paddingTop] of [
    [8, 1, 1],
    [7, 1, 0],
    [6, 0, 0],
    [4, 0, 0],
  ] as const) {
    const ui = await $.ui.mount({
      plugin: 'session',
      surface: 'terminal',
      ...BAND,
      props: { ...BAND.props, maxRows },
    })
    const box = (await ui.findAll({ type: 'Box' }))[0]!

    expect(box.props.gap).toBe(gap)
    expect(box.props.paddingTop).toBe(paddingTop)
    await ui.unmount()
  }
})

test('a category takes its true share of the bar, down to no cell at all', async ($, on) => {
  const row = (name: string, tokens: number, kind: ContextCategory['kind'] = 'used') => ({
    name,
    tokens,
    kind,
    color: 'inactive',
    isDeferred: false,
  })

  session(on, [], () => 30500, [
    row('System prompt', 300),
    row('Memory files', 200),
    row('Messages', 30000),
    row('Free space', 169500, 'free'),
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const filled = await ui.findAll({ type: 'Text', text: '█' })

  expect(texts).toContain(`Context: ████${'░'.repeat(20)} 30.5K (23%) · ■ msgs  ■ system  ■ memory`)
  expect(filled.filter(found => found.text === '█').every(found => found.props.color === 'claude')).toBe(true)
})

test('a lone small category still fills one whole cell', async ($, on) => {
  session(on, [], () => 500, [
    { name: 'System prompt', tokens: 500, kind: 'used', color: 'inactive', isDeferred: false },
    { name: 'Free space', tokens: 199500, kind: 'free', color: 'inactive', isDeferred: false },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toContain(`Context: █${'░'.repeat(23)} 500 (23%) · ■ system`)
})

test('the fill follows the time passed, whatever the usage', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 1, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts.some(text => text.startsWith(`Session: █${'█'.repeat(16)}${'░'.repeat(7)} 0% used`))).toBe(true)
  expect(texts.some(text => text.startsWith(`Weekly:  █${'█'.repeat(9)}${'░'.repeat(14)} 1% used`))).toBe(true)
})

test('the fill takes the elapsed colour and the marker its own', async ($, on) => {
  session(on, [
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-10T11:22:00Z' },
    { kind: 'seven_day', percentUsed: 100, resetsAt: '2026-10-14T10:00:00Z' },
  ])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const colors = async (glyph: string) =>
    (await ui.findAll({ type: 'Text', text: glyph }))
      .filter(found => found.text === glyph)
      .map(found => found.props.color)

  expect((await colors('█')).slice(-28)).toEqual([
    ...Array(16).fill('#999999'),
    '#333131',
    ...Array(10).fill('#999999'),
    '#333131',
  ])
  expect(texts.some(text => text.startsWith(`Weekly:  ${'█'.repeat(10)}${'░'.repeat(13)}█ 100% used`))).toBe(true)
})

test('the band is left to a survey', async ($, on) => {
  session(on, [])
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const ui = await $.ui.mount({
    plugin: 'session',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts).toEqual(['band below'])
})

test('the band is drawn again after a /clear', async ($, on) => {
  session(on, [])
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'clear' })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')

  expect(texts).toContain('Opus 5.5')
  expect(texts).toContain('46.1K')
})

test('/status-bar-mod hides the band and shows it again, across a /clear', async ($, on) => {
  session(on, [])
  on('classic.SessionStart', () => ({}))
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

  const drawn = async () => {
    const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)

    await ui.unmount()

    return texts
  }

  const toggle = () =>
    $.command.run({
      command: 'status-bar-mod',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })

  expect((await toggle()).text).toBe('Status bar hidden')
  expect(await drawn()).toEqual(['band below'])

  await $.classic.SessionStart({ source: 'clear' })
  expect(await drawn()).toEqual(['band below'])

  expect((await toggle()).text).toBe('Status bar shown')
  expect((await drawn()).join('|')).toContain('Opus 5.5')
})

test('the branch is followed by changed files, commits to push and pull, and the pull request', async ($, on) => {
  const status = (head: string, rest: string[]) => [`# branch.oid abc`, `# branch.head ${head}`, ...rest, ''].join('\n')
  const pr = (state: string) => JSON.stringify({ number: 12, state, headRefName: 'feature' })
  let host: Record<string, string> = {}

  const fetches: (Record<string, string> | undefined)[] = []

  session(on, [], () => 46100, undefined, e => {
    if (e.argv[1] === 'fetch') fetches.push(e.init?.env)

    return host
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  const drawn = async () => {
    await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })

    const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })
    const found = await ui.findAll({ type: 'Text' })

    await ui.unmount()

    return found
  }
  const line = async () => (await drawn())[0]!.text
  const turn = () => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn', reason: 'answer' })

  expect(await line()).toBe('Opus 5.5 · ~/Code/app')

  host = { 'git remote': 'origin\n', 'git status': status('(detached)', ['1 .M N... 100644 100644 100644 abc abc a.ts']) }
  expect(await line()).toBe('Opus 5.5 · ~/Code/app ±1')

  host = { 'git remote': 'origin\n', 'git status': status('feature', []) }
  expect(await line()).toBe('Opus 5.5 · ~/Code/app (feature) ↑')

  host = { 'git remote': '', 'git status': status('feature', []) }
  expect(await line()).toBe('Opus 5.5 · ~/Code/app (feature)')

  host = {
    'git remote': 'origin\n', 'git status': status('feature', [
      '# branch.upstream origin/feature',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 abc abc a.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 b.ts\tc.ts',
      'u UU N... 100644 100644 100644 100644 abc abc abc d.ts',
      '? e.ts',
    ]),
    'gh pr': pr('OPEN'),
  }
  expect(await line()).toBe('Opus 5.5 · ~/Code/app (feature) ±4 ↑2 ↓3')

  expect(fetches).toEqual([])
  await turn()
  expect(fetches).toEqual([{ GIT_TERMINAL_PROMPT: '0' }])
  expect(await line()).toBe('Opus 5.5 · ~/Code/app (feature) ±4 ↑2 ↓3 · PR #12 open')

  const colors = Object.fromEntries((await drawn()).map(found => [found.text, found.props.color]))

  expect(colors).toMatchObject({ ' ±4': 'warning', ' ↑2': 'success', ' ↓3': 'error', 'PR #12 open': 'success' })

  host = { 'git remote': 'origin\n', 'git status': status('feature', ['# branch.upstream origin/feature', '# branch.ab +0 -0']), 'gh pr': pr('MERGED') }
  await turn()
  expect(await line()).toBe('Opus 5.5 · ~/Code/app (feature) · PR #12 merged')
  expect((await drawn()).find(found => found.text === 'PR #12 merged')!.props.color).toBe('merged')

  host = { 'git remote': 'origin\n', 'git status': status('other', ['# branch.upstream origin/other', '# branch.ab +0 -0']), 'gh pr': pr('MERGED') }
  expect(await line()).toBe('Opus 5.5 · ~/Code/app (other)')

  host = { 'git remote': 'origin\n', 'git status': status('other', ['# branch.upstream origin/other', '# branch.ab +0 -0']) }
  await turn()
  host = { 'git remote': 'origin\n', 'git status': status('feature', ['# branch.upstream origin/feature', '# branch.ab +0 -0']) }
  expect(await line()).toBe('Opus 5.5 · ~/Code/app (feature)')
})

test('commits fetched at the end of a turn are drawn without another measure', async ($, on) => {
  let behind = 0

  session(on, [], () => 46100, undefined, e => {
    if (e.argv[1] === 'fetch') behind = 2

    return {
      'git remote': 'origin\n',
      'git status': `# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -${behind}\n`,
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'session', surface: 'terminal', ...BAND })

  expect((await ui.findAll({ type: 'Text' }))[0]!.text).toBe('Opus 5.5 · ~/Code/app (main) ↓2')
})
