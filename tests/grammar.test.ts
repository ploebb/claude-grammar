import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { applyFixes, compileIgnore, compileSkip, cut, entriesFrom, mergeLists, parseLists, settingsFrom, wordCount } from '../hooks/config'
import { BATCH, BUILT_IN, PART_NAMES, PROMPT_HEADER, keepFixes, parseBatch, parsePromptFile, parseReply, promptFileText, system, typedPart } from '../hooks/check'
import { STREAK_FROM, checkFor, cleanText, plainText, usefulNatural } from '../hooks/grammar'
import { KINDS, historyText, importWindow, keepable, kindOf, merge, pairsOf, parseHistory, parsePeriod, prune, record, reviewInput, statsText, summaryOf, trendOf, within } from '../hooks/history'
import type { Period } from '../hooks/history'
import type { Entry, History, Kind } from '../hooks/history'
import { batches, typedText } from '../tools/transcript'

const FIXES = {
  english: true,
  fixes: [
    { from: 'appea', to: 'appear', why: 'typo', kind: 'spelling' },
    { from: 'about', to: 'above', why: 'wrong word', kind: 'wrong word' },
  ],
}

const HOME_FILE = '/home/u/.claude/grammar.json'
const PROJECT_FILE = '/work/app/.claude/grammar.json'
const HISTORY_FILE = '/home/u/.claude/grammar-history.json'
const DAY = 86_400_000
// 2026-10-30, noon UTC.
const NOW = Date.UTC(2026, 9, 30, 12)

/** The transcript row of a prompt you typed. */
const mountRow = ($: Engine, text: string, kind = 'composer') =>
  $.ui.mount({
    plugin: 'grammar',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text, origin: { kind }, isExpanded: false } as never,
  })

// Set by a test whose disk writes should fail.
let writeFails: string | undefined

/** A home folder, a project and the files in them; returns the files, written ones included. */
const disk = (on: On, initial: Record<string, string> = {}) => {
  writeFails = undefined
  const files = new Map(Object.entries(initial))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }) as never)
  on('session.root', () => ({ value: '/work/app' }) as never)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }) as never)
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: text } as never
  })
  on('fs.write', ($, e) => {
    if (writeFails !== undefined) {
      throw new Error(writeFails)
    }
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  return files
}

/** The engine beneath: passes prompts on, draws an empty row, and draws in the terminal unless `surfaces` says otherwise. */
const engine = (on: On, surfaces: string[] = ['terminal'], files: Record<string, string> = {}, stored: Record<string, unknown> = {}) => {
  mock.store(on, stored)
  const written = disk(on, files)
  toasts.length = 0
  lines.length = 0
  on('ui.log', (_$, e) => {
    lines.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/work/app' }) as never)
  on('command.register', () => ({ value: { command: 'grammar' } }) as never)
  on('session.surfaces', () => ({ value: surfaces }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', () => ({ type: 'Box', props: { key: 'prompt' }, children: [] }) as never)
  return written
}

// The toasts of the running test.
const toasts: string[] = []
// The transcript lines of the running test.
const lines: string[] = []

type Asked = { prompts: string[]; systems: string[]; models: string[]; files: Map<string, string> }

/** The model beneath the plugin: answers `reply` (a function of the call's number, or one value), and records what it was asked. */
const haiku = (on: On, reply: unknown, surfaces?: string[], files?: Record<string, string>, stored?: Record<string, unknown>): Asked => {
  const asked: Asked = { prompts: [], systems: [], models: [], files: new Map() }
  on('model.complete', ($, e) => {
    const p = e.prompt as string | readonly { text: string }[]
    asked.prompts.push(typeof p === 'string' ? p : p.map(b => b.text).join(''))
    asked.systems.push(String(e.system))
    asked.models.push(e.model)
    const r = typeof reply === 'function' ? (reply as (n: number) => unknown)(asked.prompts.length) : reply
    return {
      value: {
        isAnswered: true,
        text: typeof r === 'string' ? r : JSON.stringify(r),
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as never
  })
  asked.files = engine(on, surfaces, files, stored)
  return asked
}

const TYPO = 'it should appea somewhere about the prompt'

test('the fixes show under the prompt in the transcript once the model answers', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, { ...FIXES, natural: 'it should show up just above the prompt' })
  await $.prompt.submit({ text: TYPO } as never)

  const checking = await mountRow($, TYPO)
  expect(await checking.find({ key: 'prompt' })).toBeDefined()
  expect(await checking.find({ key: 'gr-fixes' })).toBeUndefined()

  await clock.advance(5)
  expect(asked.prompts).toEqual([TYPO])
  expect(asked.models).toEqual(['haiku'])
  const row = await mountRow($, TYPO)
  expect(await row.find({ key: 'prompt' })).toBeDefined()
  const fixes = (await row.find({ key: 'gr-fixes' }))?.text ?? ''
  expect(fixes).toContain('appea')
  expect(fixes).toContain('appear')
  expect(fixes).toContain('wrong word')
  expect((await row.find({ key: 'gr-natural' }))?.text).toContain('it should show up just above the prompt')

  // Other prompts and other kinds of rows are left alone.
  expect(await (await mountRow($, 'something else')).find({ key: 'grammar' })).toBeUndefined()
  expect(await (await mountRow($, TYPO, 'task-notification')).find({ key: 'grammar' })).toBeUndefined()
})

test('each prompt keeps its own fixes, and a longer prompt never takes a shorter one\'s', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, (n: number) => (n === 1 ? FIXES : { english: true, fixes: [] }))
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  await $.prompt.submit({ text: `${TYPO} and more` } as never)
  await clock.advance(5)
  expect(await (await mountRow($, TYPO)).find({ key: 'gr-fixes' })).toBeDefined()
  expect(await (await mountRow($, `${TYPO} and more`)).find({ key: 'gr-fixes' })).toBeUndefined()
})

test('clean English gets a check before the prompt; other languages add nothing to the row', async ($, on) => {
  const clock = mock.clock(on)
  let reply: unknown = { english: true, fixes: [] }
  haiku(on, () => reply)

  await $.prompt.submit({ text: 'looks good to me' } as never)
  await clock.advance(5)
  const clean = await mountRow($, 'looks good to me')
  expect((await clean.find({ key: 'gr-ok' }))?.text).toBe('✓')
  expect(await clean.find({ key: 'prompt' })).toBeDefined()
  expect(await clean.find({ key: 'gr-fixes' })).toBeUndefined()
  expect(await clean.find({ key: 'gr-streak' })).toBeUndefined()

  reply = { english: false, fixes: [] }
  await $.prompt.submit({ text: 'das ist gut so' } as never)
  await clock.advance(5)
  expect(await (await mountRow($, 'das ist gut so')).find({ key: 'grammar' })).toBeUndefined()
})

test('clean prompts in a row are counted from 3; a fix or a native-speaker line resets the count', async ($, on) => {
  const clock = mock.clock(on)
  const clean = { english: true, fixes: [] }
  const replies: unknown[] = [clean, clean, clean, 'sorry, no', { english: false, fixes: [] }, clean, FIXES, clean, { ...clean, natural: 'a much better way to say it' }, clean]
  haiku(on, (n: number) => replies[n - 1])
  const prompts = replies.map((_, i) => `${TYPO} number ${i + 1}`)
  for (const text of prompts) {
    await $.prompt.submit({ text } as never)
    await clock.advance(5)
  }
  const streakOf = async (i: number) => (await (await mountRow($, prompts[i] ?? '')).find({ key: 'gr-streak' }))?.text
  const marked = async (i: number) => (await (await mountRow($, prompts[i] ?? '')).find({ key: 'gr-ok' })) !== undefined
  expect(await streakOf(0)).toBeUndefined()
  expect(await streakOf(1)).toBeUndefined()
  expect(await streakOf(2)).toBe('3 in a row')
  // A failed check and another language neither count nor reset.
  expect(await marked(3)).toBe(false)
  expect(await marked(4)).toBe(false)
  expect(await streakOf(5)).toBe('4 in a row')
  // A fix resets the count.
  expect(await marked(6)).toBe(false)
  expect(await marked(7)).toBe(true)
  expect(await streakOf(7)).toBeUndefined()
  // So does a native-speaker line, which is not a clean prompt.
  expect(await marked(8)).toBe(false)
  expect(await marked(9)).toBe(true)
})

test('clean off draws no check before a clean prompt', { options: { clean: false } }, async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, { english: true, fixes: [] })
  await $.prompt.submit({ text: 'looks good to me' } as never)
  await clock.advance(5)
  expect(await (await mountRow($, 'looks good to me')).find({ key: 'grammar' })).toBeUndefined()
})

test('a failed check says so in one dim line', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, 'sorry, no')
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(await (await mountRow($, TYPO)).find({ key: 'gr-error' })).toBeDefined()
})

test('three failures in a row pause the checks until /grammar on', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, 'sorry, no')
  for (const n of [1, 2, 3]) {
    await $.prompt.submit({ text: `prompt number ${n} here` } as never)
    await clock.advance(5)
  }
  expect((await (await mountRow($, 'prompt number 3 here')).find({ key: 'gr-error' }))?.text).toContain('paused')
  await $.prompt.submit({ text: 'prompt number 4 here' } as never)
  await clock.advance(5)
  expect(asked.prompts.length).toBe(3)

  await $.command.run({ command: 'grammar', args: 'on' } as never)
  await $.prompt.submit({ text: 'prompt number 5 here' } as never)
  await clock.advance(5)
  expect(asked.prompts.length).toBe(4)
})

test('turned off, nothing is checked', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  await $.command.run({ command: 'grammar', args: 'off' } as never)
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.prompts.length).toBe(0)
  expect(await (await mountRow($, TYPO)).find({ key: 'grammar' })).toBeUndefined()
})

test('turned off in the settings, nothing is checked', { options: { enabled: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  await $.session.start({} as never)
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.prompts.length).toBe(0)
})

test('/grammar on|off saves the setting through /config', async ($, on) => {
  const sets: unknown[] = []
  on('config.set', ($, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
  mock.store(on)
  const off = await $.command.run({ command: 'grammar', args: 'off' } as never)
  expect(off.text).toBe('English check off.')
  const toggled = await $.command.run({ command: 'grammar', args: '' } as never)
  expect(toggled.text).toContain('English check on')
  expect(sets).toEqual([
    { key: 'grammar.enabled', value: false },
    { key: 'grammar.enabled', value: true },
  ])
})

test('a setting /config refuses still holds for the session, and says so', async ($, on) => {
  on('config.set', () => ({ deny: 'locked by policy' }) as never)
  mock.store(on)
  const off = await $.command.run({ command: 'grammar', args: 'off' } as never)
  expect(off.text).toContain('this session only: locked by policy')
})

test('the 1.0 switches move into the settings once', async ($, on) => {
  const sets: unknown[] = []
  on('config.set', ($, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, undefined, { 'grammar.on': false, 'grammar.natural': true })
  await $.session.start({} as never)
  expect(sets).toEqual([{ key: 'grammar.enabled', value: false }])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.prompts.length).toBe(0)
  // The store keys are gone, so a second start moves nothing.
  await $.session.start({} as never)
  expect(sets.length).toBe(1)
})

test('/grammar with an unknown word prints the usage instead of toggling', async ($, on) => {
  mock.store(on)
  const r = await $.command.run({ command: 'grammar', args: 'of' } as never)
  expect(r.text).toContain('/grammar ignore add')
})

test('/grammar help lists the commands and what is on now', { options: { model: 'sonnet' } }, async ($, on) => {
  on('config.set', ($, e) => ({ value: e.value }) as never)
  mock.store(on)
  const help = await $.command.run({ command: 'grammar', args: 'help' } as never)
  expect(help.text).toContain('Check: on.')
  expect(help.text).toContain('Model: sonnet')
  expect(help.text).toContain('/grammar ignore add')

  await $.command.run({ command: 'grammar', args: 'off' } as never)
  expect((await $.command.run({ command: 'grammar', args: 'help' } as never)).text).toContain('Check: off.')
})

// The check's own lines and toasts; the plugin's notices start with its name.
const mine = (xs: string[]) => xs.filter(t => !t.startsWith('grammar:'))

test('on a desktop-only session the fixes show as a transcript line', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, { ...FIXES, natural: 'it should show up just above the prompt' }, ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(mine(lines)).toEqual(['appea → appear (typo)  ·  about → above (wrong word)\n↳ it should show up just above the prompt'])
  expect(mine(toasts)).toEqual([])
})

test('nothing extra shows in the terminal', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, FIXES)
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(mine(lines)).toEqual([])
  expect(mine(toasts)).toEqual([])
})

test('desktop toast shows a toast instead of a line', { options: { desktop: 'toast', show_why: false } }, async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, FIXES, ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(mine(toasts)).toEqual(['appea → appear  ·  about → above'])
  expect(mine(lines)).toEqual([])
})

test('desktop off shows nothing there', { options: { desktop: 'off' } }, async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, FIXES, ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(mine(lines)).toEqual([])
  expect(mine(toasts)).toEqual([])
})

test('desktop line and toast show a clean prompt; band mode adds no transcript line for it', { options: { desktop: 'line' } }, async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, { english: true, fixes: [] }, ['desktop'])
  for (const n of [1, 2, 3]) {
    await $.prompt.submit({ text: `looks good to me ${n}` } as never)
    await clock.advance(5)
  }
  expect(mine(lines)).toEqual(['✓ no mistakes', '✓ no mistakes', '✓ no mistakes · 3 in a row'])
})

test('desktop toast shows a clean prompt briefly', { options: { desktop: 'toast' } }, async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, { english: true, fixes: [] }, ['desktop'])
  await $.prompt.submit({ text: 'looks good to me' } as never)
  await clock.advance(5)
  expect(mine(toasts)).toEqual(['✓ no mistakes'])
  expect(mine(lines)).toEqual([])
})

test('a clean prompt adds no transcript line in band mode, and another language shows nothing on the desktop', async ($, on) => {
  const clock = mock.clock(on)
  let reply: unknown = { english: true, fixes: [] }
  haiku(on, () => reply, ['desktop'])
  await $.prompt.submit({ text: 'looks good to me' } as never)
  await clock.advance(5)
  reply = { english: false, fixes: [] }
  await $.prompt.submit({ text: 'das ist gut so' } as never)
  await clock.advance(5)
  expect(mine(lines)).toEqual([])
  expect(mine(toasts)).toEqual([])
})

test('a failed check shows as a transcript line on the desktop', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, 'sorry, no', ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(lines.filter(t => t.startsWith('no check: ')).length).toBe(1)
})

/** The band above the prompt on a surface. */
const mountBand = ($: Engine, surface: 'desktop' | 'terminal', hasSurvey = false) =>
  $.ui.mount({
    plugin: 'grammar',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false } as never,
  })

test('the desktop band shows the newest fixes in color, the terminal none', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, { ...FIXES, natural: 'it should show up just above the prompt' }, ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  const band = await mountBand($, 'desktop')
  const fixes = (await band.find({ key: 'gr-fixes' }))?.text ?? ''
  expect(fixes).toContain('appea')
  expect(fixes).toContain('appear')
  expect((await band.find({ key: 'gr-natural' }))?.text).toContain('just above the prompt')
  expect(await band.find({ key: 'hide' })).toBeDefined()
  expect(await (await mountBand($, 'terminal')).find({ key: 'grammar-band' })).toBeUndefined()
  expect(await (await mountBand($, 'desktop', true)).find({ key: 'grammar-band' })).toBeUndefined()
})

test('the desktop band draws one row per fix with plain icons, the terminal one row', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, { ...FIXES, natural: 'it should show up just above the prompt' }, ['desktop', 'terminal'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  const band = await mountBand($, 'desktop')
  expect(await band.find({ key: 'gr-row0' })).toBeDefined()
  expect(await band.find({ key: 'gr-row1' })).toBeDefined()
  expect((await band.find({ key: 'gr-fixes' }))?.text ?? '').not.toContain('  · ')
  const all = (await band.find({ key: 'grammar-band' }))?.text ?? ''
  expect(all).not.toMatch(/[\ue000-\uf8ff]/)
  expect(all).toContain('✎')
  expect(all).toContain('↳')
})

test('desktop line draws no band', { options: { desktop: 'line' } }, async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, FIXES, ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(await (await mountBand($, 'desktop')).find({ key: 'grammar-band' })).toBeUndefined()
  expect(mine(lines).length).toBe(1)
})

test('Hide hides the band until the next check', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, FIXES, ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  const band = await mountBand($, 'desktop')
  await band.press({ key: 'hide' } as never)
  expect(await (await mountBand($, 'desktop')).find({ key: 'grammar-band' })).toBeUndefined()
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(await (await mountBand($, 'desktop')).find({ key: 'grammar-band' })).toBeDefined()
})

test('a clean newest check replaces an older one in the band with a green check and the streak', async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, (n: number) => (n === 1 ? FIXES : { english: true, fixes: [] }), ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(await (await mountBand($, 'desktop')).find({ key: 'gr-fixes' })).toBeDefined()
  await $.prompt.submit({ text: 'looks good to me' } as never)
  await clock.advance(5)
  const band = await mountBand($, 'desktop')
  expect(await band.find({ key: 'gr-fixes' })).toBeUndefined()
  expect((await band.find({ key: 'gr-ok' }))?.text).toBe('✓ No mistakes')
  expect(await band.find({ key: 'hide' })).toBeDefined()
  for (const n of [2, 3]) {
    await $.prompt.submit({ text: `looks good to me ${n}` } as never)
    await clock.advance(5)
  }
  expect((await (await mountBand($, 'desktop')).find({ key: 'gr-ok' }))?.text).toBe('✓ No mistakes · 3 in a row')
})

test('clean off: a clean newest check clears the band', { options: { clean: false } }, async ($, on) => {
  const clock = mock.clock(on)
  haiku(on, (n: number) => (n === 1 ? FIXES : { english: true, fixes: [] }), ['desktop'])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  await $.prompt.submit({ text: 'looks good to me' } as never)
  await clock.advance(5)
  expect(await (await mountBand($, 'desktop')).find({ key: 'grammar-band' })).toBeUndefined()
  expect(mine(lines)).toEqual(['appea → appear (typo)  ·  about → above (wrong word)'])
})

test('clean text: the streak shows from STREAK_FROM', () => {
  expect(cleanText(1)).toBe('✓ no mistakes')
  expect(cleanText(STREAK_FROM - 1)).toBe('✓ no mistakes')
  expect(cleanText(STREAK_FROM)).toBe(`✓ no mistakes · ${STREAK_FROM} in a row`)
})

test('plain text: fixes, removals, the reason and the native-speaker line', () => {
  expect(plainText([{ from: 'the the', to: '', why: 'repeated' } as never], null, true)).toBe('the the → (remove) (repeated)')
  expect(plainText([], 'say it so', true)).toBe('↳ say it so')
})

test('a run that draws nowhere (claude -p) asks the model nothing', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, [])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.prompts).toEqual([])
})

test('prompts under the minimum words are not checked', { options: { min_words: 3 } }, async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  await $.prompt.submit({ text: 'ok go' } as never)
  await $.prompt.submit({ text: 'fix teh tests' } as never)
  await clock.advance(5)
  expect(asked.prompts).toEqual(['fix teh tests'])
})

test('the settings reach the request and the row', { options: { model: 'sonnet', dialect: 'uk', show_why: false, icons: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.models).toEqual(['sonnet'])
  expect(asked.systems[0]).toContain('British English')
  expect(asked.systems[0]).not.toContain('"why"')
  const fixes = (await (await mountRow($, TYPO)).find({ key: 'gr-fixes' }))?.text ?? ''
  expect(fixes).toContain('appear')
  expect(fixes).not.toContain('wrong word')
  expect(fixes.startsWith('*')).toBe(true)
})

test('ignored words are told to the model and their fixes dropped; skipped prompts are not sent', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, {
    [HOME_FILE]: JSON.stringify({ ignore: ['appea'] }),
    [PROJECT_FILE]: JSON.stringify({ ignore: ['/^ab.ut$/'], skip: ['^deploy '] }),
  })
  await $.prompt.submit({ text: TYPO } as never)
  await $.prompt.submit({ text: 'deploy it to staging pls' } as never)
  await clock.advance(5)
  expect(asked.prompts).toEqual([TYPO])
  expect(asked.systems[0]).toContain('"appea"')
  // Regex entries are matched locally only.
  expect(asked.systems[0]).not.toContain('ab.ut')
  expect(await (await mountRow($, TYPO)).find({ key: 'gr-fixes' })).toBeUndefined()
})

test('a grammar.json that does not parse is reported once and the check goes on', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, { [HOME_FILE]: '{ "ignore": [' })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(asked.prompts.length).toBe(2)
  const broken = toasts.filter(t => t.includes('is ignored'))
  expect(broken.length).toBe(1)
  expect(broken[0]).toContain(HOME_FILE)
})

test('/grammar ignore add, rm and list edit the global file and keep the rest of it', async ($, on) => {
  const files = engine(on, ['terminal'], { [HOME_FILE]: JSON.stringify({ skip: ['^ok$'], ignore: ['kubectl'] }) })
  const added = await $.command.run({ command: 'grammar', args: 'ignore add pnpm, pull request' } as never)
  expect(added.text).toContain('"pull request"')
  expect(JSON.parse(files.get(HOME_FILE) ?? '{}')).toEqual({ skip: ['^ok$'], ignore: ['kubectl', 'pnpm', 'pull request'] })

  await $.command.run({ command: 'grammar', args: 'ignore rm KUBECTL' } as never)
  expect(JSON.parse(files.get(HOME_FILE) ?? '{}').ignore).toEqual(['pnpm', 'pull request'])

  const list = await $.command.run({ command: 'grammar', args: 'ignore' } as never)
  expect(list.text).toContain('pnpm, pull request')
  expect(list.text).toContain('^ok$')
})

test('/grammar ignore add leaves a file that does not parse alone', async ($, on) => {
  const files = engine(on, ['terminal'], { [HOME_FILE]: 'not json' })
  const r = await $.command.run({ command: 'grammar', args: 'ignore add pnpm' } as never)
  expect(r.text).toContain('does not parse')
  expect(files.get(HOME_FILE)).toBe('not json')
})

test('slash commands and sent answers are not checked', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  await $.prompt.submit({ text: 'Answers to your questions:\n#1 ("Which port?"): 4222' } as never)
  await clock.advance(5)
  expect(asked.prompts).toEqual([])
})

test('answers appended by open-questions are not checked with the prompt', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  const sent = `${TYPO}\n\nAnswer to your question #1 ("Which port do you want?"): 4222`
  await $.prompt.submit({ text: sent } as never)
  await clock.advance(5)
  expect(asked.prompts).toEqual([TYPO])
  expect(await (await mountRow($, sent)).find({ key: 'gr-fixes' })).toBeDefined()
  expect(typedPart('Answers to your questions:\n#1 ("x"): y')).toBe('')
})

test('the reply is parsed, and a row finds its check even with text appended', () => {
  expect(parseReply('```json\n{"english": false, "fixes": []}\n```')).toBeNull()
  const reply = parseReply(JSON.stringify(FIXES))
  expect(reply?.fixes.length).toBe(2)
  expect(reply?.natural).toBeNull()
  expect(parseReply('{"english": true, "fixes": [{"from": "a", "to": "b"}]}')?.fixes[0]?.why).toBe('')
  expect(() => parseReply('sorry, no')).toThrow()

  const all = [
    { id: 2, text: 'fix it', status: 'done' as const, fixes: [] },
    { id: 1, text: 'fix it', status: 'done' as const, fixes: FIXES.fixes },
  ]
  expect(checkFor(all, 'fix it\n\nAnswers to your questions: …')?.id).toBe(2)
  expect(checkFor(all, 'fix it now')).toBeUndefined()
  expect(checkFor(all, 'other')).toBeUndefined()
})

test('fixes for words the prompt does not hold, or that are ignored, are dropped', () => {
  const fixes = [...FIXES.fixes, { from: 'invented words', to: 'x', why: 'typo' }]
  expect(keepFixes(fixes, TYPO, compileIgnore([])).map(f => f.from)).toEqual(['appea', 'about'])
  expect(keepFixes(fixes, TYPO, compileIgnore(['ABOUT'])).map(f => f.from)).toEqual(['appea'])
  expect(keepFixes(fixes, TYPO, compileIgnore(['/^app/'])).map(f => f.from)).toEqual(['about'])
  // A plain word matches whole words only.
  expect(keepFixes(fixes, TYPO, compileIgnore(['app'])).map(f => f.from)).toEqual(['appea', 'about'])
})

test('a natural rewrite is kept only when it says something new', () => {
  const reply = parseReply(JSON.stringify({ ...FIXES, natural: 'it should show up just above the prompt' }))
  expect(reply?.natural).toBe('it should show up just above the prompt')
  expect(applyFixes(TYPO, FIXES.fixes)).toBe('it should appear somewhere above the prompt')
  expect(usefulNatural('It should appear somewhere above the prompt.', TYPO, FIXES.fixes)).toBeNull()
  expect(usefulNatural('looks good', 'looks good', [])).toBeNull()
  expect(usefulNatural('the way I prompt', 'the way how i prompt', [])).toBe('the way I prompt')
  // It may not drop a word the user said to keep.
  expect(usefulNatural('run the cluster tool', 'run kubectl tool how', [], compileIgnore(['kubectl']))).toBeNull()
  expect(system({ natural: true })).toContain('"natural"')
  expect(system({ natural: false })).not.toContain('"natural"')
})

test('/grammar natural off hides the natural line and stops asking for it', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, { english: true, fixes: [], natural: 'the way I prompt' })

  await $.prompt.submit({ text: 'the way how i prompt' } as never)
  await clock.advance(5)
  expect(await (await mountRow($, 'the way how i prompt')).find({ key: 'gr-natural' })).toBeDefined()
  expect(asked.systems[0]).toContain('"natural"')

  const off = await $.command.run({ command: 'grammar', args: 'natural off' } as never)
  expect(off.text).toContain('Natural phrasing off')
  expect(await (await mountRow($, 'the way how i prompt')).find({ key: 'grammar' })).toBeUndefined()

  await $.prompt.submit({ text: 'the way how i prompt' } as never)
  await clock.advance(5)
  expect(asked.systems[1]).not.toContain('"natural"')
})

test('config helpers: settings, lists, words and cuts', () => {
  expect(settingsFrom({})).toEqual({
    enabled: true,
    natural: true,
    model: 'haiku',
    effort: 'low',
    dialect: 'any',
    minWords: 2,
    maxChars: 6000,
    icons: true,
    showWhy: true,
    desktop: 'band',
    history: true,
    clean: true,
  })
  expect(settingsFrom({ effort: 'max', max_chars: 5, dialect: 'au' })).toMatchObject({ effort: 'low', maxChars: 200, dialect: 'any', desktop: 'band' })
  expect(parseLists('{"ignore": ["a", 3, ""], "other": 1}')).toEqual({ ignore: ['a'], skip: [], history: true })
  expect(parseLists('{"history": false}').history).toBe(false)
  expect(() => parseLists('[]')).toThrow()
  expect(mergeLists({ ignore: ['a'], skip: [], history: true }, { ignore: ['a', 'b'], skip: ['x'], history: true })).toEqual({
    ignore: ['a', 'b'],
    skip: ['x'],
    history: true,
  })
  expect(mergeLists({ ignore: [], skip: [], history: true }, { ignore: [], skip: [], history: false }).history).toBe(false)
  expect(compileSkip(['^ok$', '/(/', '/^Y/']).map(r => r.test('OK'))).toEqual([true, false])
  expect(wordCount("let's go, ok")).toBe(3)
  expect(cut('one two three four', 10)).toBe('one two')
  expect(entriesFrom('a b')).toEqual(['a', 'b'])
  expect(entriesFrom('pull request, pnpm')).toEqual(['pull request', 'pnpm'])
})

// The mistake history.

const entry = (from: string, to: string, kind: Kind, at = NOW): Entry => ({ from, to, why: '', kind, at })

/** A history of `n` copies of each fix, and a day with `checked` prompts. */
const seeded = (fixes: [string, string, Kind, number][], checked = 40, withFixes = 20): History => ({
  version: 1,
  fixes: fixes.flatMap(([from, to, kind, n]) => Array.from({ length: n }, () => entry(from, to, kind))),
  days: [{ day: '2026-10-30', checked, withFixes }],
})

test('each checked prompt is kept in the history with its fixes, and a session with no history yet says where', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const asked = haiku(on, (n: number) => (n === 1 ? FIXES : { english: true, fixes: [] }))
  await $.session.start({} as never)
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  await $.prompt.submit({ text: 'looks good to me' } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toContain('"kind"')
  const h = parseHistory(asked.files.get(HISTORY_FILE) ?? '')
  expect(h.fixes.map(f => [f.from, f.to, f.kind, f.at])).toEqual([
    ['appea', 'appear', 'spelling', NOW + 1],
    ['about', 'above', 'wrong word', NOW + 1],
  ])
  expect(h.days).toEqual([{ day: '2026-10-30', checked: 2, withFixes: 1 }])
  const notes = toasts.filter(t => t.includes(HISTORY_FILE))
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('/grammar history off')
  // Once the file is there, a new session says nothing.
  await $.session.start({} as never)
  expect(toasts.filter(t => t.includes(HISTORY_FILE)).length).toBe(1)
})

test('the history notice shows once ever, and not in a project that keeps nothing', async ($, on) => {
  haiku(on, FIXES, undefined, { [PROJECT_FILE]: '{"history": false}' })
  await $.session.start({} as never)
  expect(toasts.filter(t => t.includes(HISTORY_FILE))).toEqual([])
})

test('the history notice does not come back when the file is deleted after it showed', async ($, on) => {
  haiku(on, FIXES, undefined, {}, { 'grammar.historyAnnounced': true })
  await $.session.start({} as never)
  expect(toasts.filter(t => t.includes(HISTORY_FILE))).toEqual([])
})

test('two checks that finish together both land in the history', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const asked = haiku(on, FIXES)
  await $.prompt.submit({ text: TYPO } as never)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  const h = parseHistory(asked.files.get(HISTORY_FILE) ?? '')
  expect(h.days[0]?.checked).toBe(2)
  expect(h.fixes.length).toBe(4)
})

test('a history write that fails says so once, and the fixes still show', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  haiku(on, FIXES)
  writeFails = 'disk full'
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(toasts.filter(t => t.includes('no fixes kept')).length).toBe(1)
  expect(await (await mountRow($, TYPO)).find({ key: 'gr-fixes' })).toBeDefined()
})

test('a history torn by two sessions keeps the lines that still parse, and the next check makes it whole', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const whole = historyText(seeded([['depend from', 'depend on', 'preposition', 2]]))
  const torn = `${whole}  {"from": "half a li`
  expect(parseHistory(torn).fixes.length).toBe(2)
  expect(parseHistory(torn).days.length).toBe(1)
  const asked = haiku(on, FIXES, undefined, { [HISTORY_FILE]: torn })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  const h = parseHistory(asked.files.get(HISTORY_FILE) ?? '')
  expect(h.fixes.length).toBe(4)
  expect(JSON.parse(asked.files.get(HISTORY_FILE) ?? '').version).toBe(1)

  // A write cut short among the fixes keeps the day counts, which come first, and the fixes before the cut.
  const cut = whole.slice(0, whole.lastIndexOf('depend from') + 4)
  expect(parseHistory(cut).days).toEqual([{ day: '2026-10-30', checked: 40, withFixes: 20 }])
  expect(parseHistory(cut).fixes.length).toBe(1)
})

test('ignored words, failed checks and other languages are not kept', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let reply: unknown = FIXES
  const asked = haiku(on, () => reply, undefined, { [HOME_FILE]: JSON.stringify({ ignore: ['appea'] }) })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  reply = 'sorry, no'
  await $.prompt.submit({ text: 'another prompt here' } as never)
  await clock.advance(5)
  reply = { english: false, fixes: [] }
  await $.prompt.submit({ text: 'das ist gut so' } as never)
  await clock.advance(5)
  const h = parseHistory(asked.files.get(HISTORY_FILE) ?? '')
  expect(h.fixes.map(f => f.from)).toEqual(['about'])
  expect(h.days[0]?.checked).toBe(1)
})

test('history off, in the settings or a project, keeps nothing and stops asking for the kind', { options: { history: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const asked = haiku(on, FIXES)
  await $.session.start({} as never)
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.files.has(HISTORY_FILE)).toBe(false)
  expect(asked.systems[0]).not.toContain('"kind"')
})

test('a project whose grammar.json says "history": false keeps nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const asked = haiku(on, FIXES, undefined, { [PROJECT_FILE]: JSON.stringify({ history: false }) })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.files.has(HISTORY_FILE)).toBe(false)
  expect(await (await mountRow($, TYPO)).find({ key: 'gr-fixes' })).toBeDefined()
  const status = await $.command.run({ command: 'grammar', args: 'history' } as never)
  expect(status.text).toContain('off in this project')
})

test('/grammar history off|on saves the setting, and clear empties the file', async ($, on) => {
  const sets: unknown[] = []
  on('config.set', ($, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
  const clock = mock.clock(on, { now: NOW })
  const asked = haiku(on, FIXES, undefined, { [HISTORY_FILE]: historyText(seeded([['depend from', 'depend on', 'preposition', 3]])) })
  const off = await $.command.run({ command: 'grammar', args: 'history off' } as never)
  expect(off.text).toContain('History off')
  expect(sets).toEqual([{ key: 'grammar.history', value: false }])
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(parseHistory(asked.files.get(HISTORY_FILE) ?? '').fixes.length).toBe(3)

  const cleared = await $.command.run({ command: 'grammar', args: 'history clear' } as never)
  expect(cleared.text).toContain('Cleared')
  expect(parseHistory(asked.files.get(HISTORY_FILE) ?? '')).toEqual({ version: 1, fixes: [], days: [] })
  expect((await $.command.run({ command: 'grammar', args: 'history' } as never)).text).toContain('0 fixes kept')
})

test('a history file that does not parse is left alone and reported once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const asked = haiku(on, FIXES, undefined, { [HISTORY_FILE]: '{ "fixes": [' })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(asked.files.get(HISTORY_FILE)).toBe('{ "fixes": [')
  expect(toasts.filter(t => t.includes('does not parse')).length).toBe(1)
  // The check itself goes on.
  expect(await (await mountRow($, TYPO)).find({ key: 'gr-fixes' })).toBeDefined()
  expect((await $.command.run({ command: 'grammar', args: 'stats' } as never)).text).toContain('does not parse')
})

test('/grammar stats counts by kind and repeats, with nothing kept yet said plainly', async ($, on) => {
  mock.clock(on, { now: NOW })
  const files = engine(on)
  expect((await $.command.run({ command: 'grammar', args: 'stats' } as never)).text).toContain('Nothing kept yet')
  files.set(
    HISTORY_FILE,
    historyText(
      seeded([
        ['depend from', 'depend on', 'preposition', 3],
        ['Depend  from', 'depend on', 'preposition', 2],
        ['a file', 'the file', 'article', 2],
        ['teh', 'the', 'spelling', 1],
      ]),
    ),
  )
  const stats = (await $.command.run({ command: 'grammar', args: 'stats' } as never)).text ?? ''
  expect(stats).toContain('40 prompts checked, 20 with a fix (50%), 8 fixes kept')
  expect(stats).toContain('preposition     5   63%  e.g. depend from → depend on')
  expect(stats).toContain('×5   depend from → depend on')
  expect(stats).not.toContain('×1')
  expect(stats).toContain('advice from 20 fixes; 8 so far')
  expect(stats).toContain(HISTORY_FILE)
})

test('/grammar review waits for enough fixes, then asks Sonnet once with the grouped fixes', async ($, on) => {
  mock.clock(on, { now: NOW })
  const asked = haiku(on, '1. You leave out "the".\n  a file → the file', undefined, {
    [HISTORY_FILE]: historyText(seeded([['depend from', 'depend on', 'preposition', 12]])),
    // Added to the ignore list after its fixes were kept: they no longer count.
    [HOME_FILE]: JSON.stringify({ ignore: ['kubectl'] }),
  })
  const early = await $.command.run({ command: 'grammar', args: 'review' } as never)
  expect(early.text).toContain('12 fixes kept for everything kept, the review starts at 20')
  expect(asked.prompts.length).toBe(0)

  asked.files.set(
    HISTORY_FILE,
    historyText(seeded([['depend from', 'depend on', 'preposition', 30], ['a file', 'the file', 'article', 25], ['kubectl', 'kubectl', 'other', 9]])),
  )
  const r = await $.command.run({ command: 'grammar', args: 'review' } as never)
  expect(r.text).toContain('You leave out "the"')
  expect(r.text).toContain('(sonnet, from 55 fixes)')
  expect(asked.models).toEqual(['sonnet'])
  expect(asked.prompts[0]).toContain('30× depend from → depend on (preposition)')
  expect(asked.prompts[0]).toContain('25× a file → the file (article)')
})

test('/grammar review falls back when the API says Sonnet is not available, and stops on other errors', async ($, on) => {
  mock.clock(on, { now: NOW })
  const models: string[] = []
  let [status, error] = [403, 'permission_denied']
  on('model.complete', ($, e) => {
    models.push(e.model)
    if (e.model === 'sonnet') {
      return { value: { isAnswered: false, reason: 'api-error', status, error, usage: { input_tokens: 0, output_tokens: 0 } } } as never
    }
    return { value: { isAnswered: true, text: '1. advice', usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  engine(on, ['terminal'], { [HISTORY_FILE]: historyText(seeded([['depend from', 'depend on', 'preposition', 60]])) })
  expect((await $.command.run({ command: 'grammar', args: 'review' } as never)).text).toContain('(haiku, from 60 fixes)')
  expect(models).toEqual(['sonnet', 'haiku'])

  // A missing model said by name, whatever the status, falls back too.
  models.length = 0
  ;[status, error] = [400, 'model_not_found']
  expect((await $.command.run({ command: 'grammar', args: 'review' } as never)).text).toContain('(haiku, from 60 fixes)')
  expect(models).toEqual(['sonnet', 'haiku'])

  // An overload is not a missing model: no second call, and the reason is shown.
  models.length = 0
  ;[status, error] = [529, 'overloaded']
  const r = await $.command.run({ command: 'grammar', args: 'review' } as never)
  expect(models).toEqual(['sonnet'])
  expect(r.text).toContain('sonnet: api-error (529, overloaded)')

  // Nor is a failed login, which would fail for every model.
  models.length = 0
  ;[status, error] = [401, 'authentication_failed']
  expect((await $.command.run({ command: 'grammar', args: 'review' } as never)).text).toContain('sonnet: api-error (401, authentication_failed)')
  expect(models).toEqual(['sonnet'])
})

test('/grammar review falls back to the check\'s model when Sonnet is not allowed', async ($, on) => {
  mock.clock(on, { now: NOW })
  const models: string[] = []
  on('model.complete', ($, e) => {
    models.push(e.model)
    if (e.model === 'sonnet') {
      throw new Error('model not allowed')
    }
    return { value: { isAnswered: true, text: '1. advice', usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  engine(on, ['terminal'], { [HISTORY_FILE]: historyText(seeded([['depend from', 'depend on', 'preposition', 60]])) })
  const r = await $.command.run({ command: 'grammar', args: 'review' } as never)
  expect(models).toEqual(['sonnet', 'haiku'])
  expect(r.text).toContain('(haiku, from 60 fixes)')
})

test('history helpers: kinds, code, caps, trend and the file round trip', () => {
  expect(kindOf('Word-Order')).toBe('word order')
  expect(kindOf('vibes')).toBe('other')
  expect(parseReply(JSON.stringify(FIXES))?.fixes[1]?.kind).toBe('wrong word')

  const fix = (from: string, to = 'x') => ({ from, to, why: '' })
  expect(keepable(fix('depend from'))).toBe(true)
  for (const code of ['src/app', 'auth.ts', 'my_var', 'call()', '`x`', 'from .zshrc', 'a'.repeat(61)]) {
    expect(keepable(fix(code))).toBe(false)
  }

  // Old fixes and days go; the newest 2000 stay.
  const old: History = {
    version: 1,
    fixes: [entry('old one', 'x', 'other', NOW - 91 * DAY), ...Array.from({ length: 2000 }, (_, i) => entry(`w${i}`, 'x', 'other'))],
    days: [{ day: '2026-07-01', checked: 5, withFixes: 5 }],
  }
  const next = record(old, [{ ...fix('new one'), kind: 'tense' }], NOW)
  expect(next.fixes.length).toBe(2000)
  expect(next.fixes[0]?.from).toBe('w1')
  expect(next.fixes.at(-1)).toEqual({ from: 'new one', to: 'x', why: '', kind: 'tense', at: NOW })
  expect(next.days).toEqual([{ day: '2026-10-30', checked: 1, withFixes: 1 }])
  expect(parseHistory(historyText(next))).toEqual(next)
  expect(parseHistory('{"fixes": [{"from": 1}], "days": "x"}')).toEqual({ version: 1, fixes: [], days: [] })
  expect(() => parseHistory('[]')).toThrow()
  // A time or count that is no number (1e999 reads as Infinity) drops its entry rather than break every command.
  const odd = parseHistory('{"fixes": [{"from": "a", "to": "b", "at": 1e999}], "days": [{"day": "x", "checked": 1, "withFixes": 0}, {"day": "2026-10-30", "checked": 1e999, "withFixes": 0}]}')
  expect(odd).toEqual({ version: 1, fixes: [], days: [] })

  // Case alone is not a mistake: not kept, and one kept before is not counted.
  expect(keepable(fix('Github', 'GitHub'))).toBe(false)
  expect(keepable(fix('pull  request', 'pull request'))).toBe(false)
  const cased = { version: 1 as const, fixes: [entry('Github', 'GitHub', 'spelling'), entry('teh', 'the', 'spelling')], days: [] }
  expect(statsText(cased, compileIgnore([]), NOW, HISTORY_FILE, true)).toContain('1 fixes kept')

  // Kept by calendar day: today and the 89 before, the same days "everything kept" covers.
  const edge = prune({ version: 1, fixes: [entry('late', 'x', 'other', Date.UTC(2026, 7, 1, 23)), entry('early', 'x', 'other', Date.UTC(2026, 7, 2))], days: [] }, NOW)
  expect(edge.fixes.map(f => f.from)).toEqual(['early'])
  expect(within(edge, parsePeriod('', NOW) as Period).fixes.length).toBe(1)

  // The trend needs 10 checks on each side.
  const days = [
    { day: '2026-09-10', checked: 20, withFixes: 10 },
    { day: '2026-10-20', checked: 20, withFixes: 5 },
  ]
  expect(trendOf(days, NOW)).toEqual({ recent: 0.25, before: 0.5 })
  expect(trendOf(days.slice(1), NOW)).toBeUndefined()
  // The day exactly 30 days back belongs to the earlier window.
  expect(trendOf([{ day: '2026-09-30', checked: 10, withFixes: 10 }, { day: '2026-10-01', checked: 10, withFixes: 0 }], NOW)).toEqual({ recent: 0, before: 1 })
  const h = { version: 1 as const, fixes: [entry('a file', 'the file', 'article')], days }
  expect(statsText(h, compileIgnore([]), NOW, HISTORY_FILE, true)).toContain('Fewer than before: 25% of prompts had a fix in the last 30 days, 50% in the 30 before.')
  expect(statsText(h, compileIgnore(['a file']), NOW, HISTORY_FILE, true)).not.toContain('a file')
  expect(reviewInput([entry('teh', '', 'extra word')])).toContain('1× teh → (drop it) (extra word)')

  // A repeated fix takes the kind the model gave it most often.
  const mixed = [entry('in post', 'in a post', 'missing word'), entry('in post', 'in a post', 'article'), entry('in post', 'in a post', 'article')]
  expect(pairsOf(mixed)[0]?.kind).toBe('article')
  expect(system({ natural: false })).toContain('article is a missing, extra or wrong a, an or the')
  expect(system({ natural: false, kind: false })).not.toContain('article is a missing')
})

test('the import window covers the days of the same period and stops where the history begins', () => {
  // NOW is 2026-10-30 12:00 UTC: 3 days are Oct 28, 29 and 30, as /grammar stats 3d counts them.
  expect(importWindow(NOW, 3)).toEqual({ from: Date.UTC(2026, 9, 28), to: NOW })
  // A second run after the first one's history starts on 10-28: nothing left, not a lost morning.
  expect(importWindow(NOW, 3, '2026-10-28')).toBeUndefined()
  expect(importWindow(NOW, 7, '2026-10-27')).toEqual({ from: Date.UTC(2026, 9, 24), to: Date.UTC(2026, 9, 27) })
  // A history that starts today, from the plugin itself: the days before it, when the period reaches them.
  expect(importWindow(NOW, 1, '2026-10-30')).toBeUndefined()
  expect(importWindow(NOW, 2, '2026-10-30')).toEqual({ from: Date.UTC(2026, 9, 29), to: Date.UTC(2026, 9, 30) })
})

test('import helpers: a batch reply by id, and an import merged before the live history', () => {
  const reply = parseBatch(
    'Here: [{"id": 0, "english": true, "fixes": [{"from": "teh", "to": "the", "kind": "spelling"}]}, {"id": 1, "english": false, "fixes": []}, {"id": 2, "oops": 1}, {"text": "no id"}]',
  )
  expect(reply.get(0)?.fixes.map(f => [f.from, f.kind])).toEqual([['teh', 'spelling']])
  expect(reply.get(1)).toBeNull()
  // An answer without fixes is left out, so the tool counts that prompt as not checked.
  expect(reply.has(2)).toBe(false)
  expect(() => parseBatch('sorry')).toThrow()
  expect(system({ natural: false }) + BATCH).toContain('"id"')
  // A batch of one answered with a lone object, not an array: that object is the one answer.
  expect(parseBatch('{"id": 7, "english": true, "fixes": [{"from": "teh", "to": "the"}]}').get(7)?.fixes.length).toBe(1)
  expect(parseBatch('```json\n{"id": 3, "english": false, "fixes": []}\n```').get(3)).toBeNull()

  // Transcript lines: only prompts you typed or queued, with their text, time and folder.
  const line = (o: object) => JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-29T10:00:00.000Z', cwd: '/work/app', ...o })
  expect(typedText(line({ promptSource: 'typed', message: { content: 'explain me this' } }))).toEqual({
    text: 'explain me this',
    at: Date.UTC(2026, 9, 29, 10),
    cwd: '/work/app',
    uuid: 'u1',
  })
  expect(typedText(line({ promptSource: 'queued', message: { content: [{ type: 'text', text: 'and ' }, { type: 'image' }, { type: 'text', text: 'this' }] } }))?.text).toBe('and this')
  expect(typedText(line({ message: { content: '[Request interrupted by user]' } }))).toBeUndefined()
  expect(typedText(line({ promptSource: 'typed', isSidechain: true, message: { content: 'x y' } }))).toBeUndefined()
  expect(typedText(line({ promptSource: 'typed', isMeta: true, message: { content: 'x y' } }))).toBeUndefined()
  expect(typedText('{"promptSource":"typed", torn')).toBeUndefined()
  // Batches: 20 prompts or 8000 characters, whichever comes first; a longer prompt goes alone.
  expect(batches(Array.from({ length: 45 }, () => ({ text: 'x' }))).map(b => b.length)).toEqual([20, 20, 5])
  expect(batches([{ text: 'a'.repeat(5000) }, { text: 'b'.repeat(5000) }, { text: 'c'.repeat(9000) }, { text: 'd' }]).map(b => b.length)).toEqual([1, 1, 1, 1])

  const old = record(record({ version: 1, fixes: [], days: [] }, [{ from: 'teh', to: 'the', why: '', kind: 'spelling' }], NOW - 3 * DAY), [], NOW - 3 * DAY)
  const live = record({ version: 1, fixes: [], days: [] }, [{ from: 'a file', to: 'the file', why: '', kind: 'article' }], NOW)
  const both = merge(live, old, NOW)
  expect(both.fixes.map(f => f.from)).toEqual(['teh', 'a file'])
  expect(both.days).toEqual([
    { day: '2026-10-27', checked: 2, withFixes: 1 },
    { day: '2026-10-30', checked: 1, withFixes: 1 },
  ])
  expect(merge(old, old, NOW).days[0]?.checked).toBe(4)
})

/** The output row of a /grammar command. */
const mountOutput = ($: Engine, args: string, text: string) =>
  $.ui.mount({
    plugin: 'grammar',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'grammar', args, text, isErrored: false } as never,
  })

/** Fixes and day counts spread over the days before NOW: `perDay[i]` is [checked, withFixes, fixes] for i days ago. */
const spread = (perDay: [number, number, [string, string, Kind][]][]): History => ({
  version: 1,
  fixes: perDay.flatMap(([, , fixes], i) => fixes.map(([from, to, kind]) => entry(from, to, kind, NOW - i * DAY))).sort((a, b) => a.at - b.at),
  days: perDay
    .map(([checked, withFixes], i) => ({ day: new Date(NOW - i * DAY).toISOString().slice(0, 10), checked, withFixes }))
    .reverse(),
})

test('periods: days, a start date, everything kept, and what does not read', () => {
  const week = parsePeriod('7d', NOW) as Period
  expect(week).toEqual({
    fromDay: '2026-10-24',
    toDay: '2026-10-30',
    label: 'last 7 days',
    before: { fromDay: '2026-10-17', toDay: '2026-10-23', label: 'the 7 days before' },
  })
  expect(parsePeriod('1d', NOW)).toMatchObject({ label: 'today', before: { fromDay: '2026-10-29', label: 'yesterday' } })
  // The stretch before is cut to the 90 days kept, and says so; past them there is none.
  expect((parsePeriod('60d', NOW) as Period).before).toEqual({ fromDay: '2026-08-02', toDay: '2026-08-31', label: 'the 30 kept days before' })
  expect(parsePeriod('90d', NOW)).not.toHaveProperty('before')
  expect(parsePeriod('since 2026-01-01', NOW)).toMatchObject({ fromDay: '2026-08-02' })
  expect(parsePeriod('since 2026-01-01', NOW)).not.toHaveProperty('before')
  expect(parsePeriod('since 2026-10-28', NOW)).toMatchObject({ fromDay: '2026-10-28', label: 'since Oct 28', before: { fromDay: '2026-10-25', toDay: '2026-10-27' } })
  expect(parsePeriod('', NOW)).toMatchObject({ fromDay: '2026-08-02', label: 'everything kept' })
  expect(parsePeriod('', NOW)).not.toHaveProperty('before')
  expect(parsePeriod('91d', NOW)).toContain('pick 1d to 90d')
  expect(parsePeriod('since 2026-11-01', NOW)).toContain('not a day up to today')
  expect(parsePeriod('since 2026-02-30', NOW)).toContain('not a day up to today')
  expect(parsePeriod('last week', NOW)).toContain('7d, 30d')

  // Eleven checks a day: the last 7 days against the 7 before them.
  const h = spread(
    Array.from({ length: 14 }, (_, i): [number, number, [string, string, Kind][]] =>
      i < 7 ? [11, 3, [['a file', 'the file', 'article']]] : [11, 8, [['teh', 'the', 'spelling'], ['teh', 'the', 'spelling']]],
    ),
  )
  expect(within(h, week).fixes.length).toBe(7)
  const m = summaryOf(h, compileIgnore([]), week, NOW)
  expect(m).toMatchObject({ label: 'last 7 days', range: 'Oct 24 – Oct 30', checked: 77, withFixes: 21, fixes: 7 })
  expect(m.trend?.fewer).toBe(true)
  expect(m.trend?.text).toBe('Fewer than the 7 days before (73%)')
  expect(m.kinds).toEqual([{ kind: 'article', n: 7, share: 1 }])
  expect(m.top).toMatchObject({ from: 'a file', to: 'the file', count: 7 })
  // Everything kept starts where the data does.
  expect(summaryOf(h, compileIgnore([]), parsePeriod('', NOW) as Period, NOW).range).toBe('Oct 17 – Oct 30')

  const stats = statsText(h, compileIgnore([]), NOW, HISTORY_FILE, true, week, '7d')
  expect(stats).toContain('Last 7 days (Oct 24 – Oct 30): 77 prompts checked, 21 with a fix (27%), 7 fixes kept.')
  expect(stats).toContain('Fewer than the 7 days before (73%).')
  expect(stats).not.toContain('teh')
  expect(statsText(h, compileIgnore([]), NOW, HISTORY_FILE, true, parsePeriod('since 2026-10-30', NOW) as Period)).toContain('Since Oct 30 (Oct 30)')
})

test('/grammar review 7d reviews only that week and opens with a summary card', async ($, on) => {
  mock.clock(on, { now: NOW })
  const old = Array.from({ length: 30 }, () => entry('teh', 'the', 'spelling', NOW - 20 * DAY))
  const week = Array.from({ length: 25 }, (_, i) => entry(i < 20 ? 'a file' : 'depend from', i < 20 ? 'the file' : 'depend on', i < 20 ? 'article' : 'preposition', NOW - DAY))
  const h: History = { version: 1, fixes: [...old, ...week], days: [{ day: '2026-10-10', checked: 40, withFixes: 30 }, { day: '2026-10-29', checked: 50, withFixes: 20 }] }
  const asked = haiku(on, '1. You leave out "the" before known things.\n  a file → the file\n  check file → check the file\n\n2. Prepositions after verbs.\n  depend from → depend on', undefined, {
    [HISTORY_FILE]: historyText(h),
  })
  const r = await $.command.run({ command: 'grammar', args: 'review 7d' } as never)
  expect(asked.prompts[0]).toContain('25 fixes.')
  expect(asked.prompts[0]).not.toContain('teh')
  const text = r.text ?? ''
  expect(text.startsWith('Grammar review · last 7 days (Oct 24 – Oct 30)\n50 prompts · 40% with a fix · 25 fixes')).toBe(true)
  expect(text).toContain('article 80% · preposition 20%')
  expect(text).toContain('most repeated: a file → the file ×20')
  expect(text).toContain('(sonnet, from 25 fixes)')

  // Drawn: the card, the habits, each example struck through and fixed.
  const row = await mountOutput($, 'review 7d', text)
  const card = (await row.find({ key: 'gr-panel' }))?.text ?? ''
  expect(card).toContain('Grammar review')
  expect(card).toContain('50 prompts · 40% with a fix · 25 fixes')
  expect(card).toContain('article')
  expect(card).toContain('█')
  const advice = (await row.find({ key: 'gr-advice' }))?.text ?? ''
  expect(advice).toContain('1. You leave out "the" before known things.')
  expect(advice).toContain('check file the file'.replace(' the', ' check the'))
  expect(advice).not.toContain('→')
  expect((await row.find({ key: 'gr-footer' }))?.text).toContain('sonnet, from 25 fixes')

  // Other /grammar rows, and a period too short for a review, draw as plain text.
  expect(await (await mountOutput($, 'help', 'Check: on.')).find({ key: 'gr-panel' })).toBeUndefined()
  expect((await $.command.run({ command: 'grammar', args: 'review 1d' } as never)).text).toContain('Try a longer period')
  expect((await $.command.run({ command: 'grammar', args: 'review someday' } as never)).text).toContain('7d, 30d')
})

const PROMPT_FILE = '/home/u/.claude/grammar-prompt.md'
const NOW_SYSTEM = { natural: true, kind: true } as const

/** main's system(), as it was before the prompt could be overridden part by part. */
const legacySystem = ({ natural, dialect = 'any', showWhy = true, kind = true, ignore = [] }: Parameters<typeof system>[0]) => {
  const base = `You proofread English that a non-native speaker typed as a prompt to a coding assistant.
Report only real mistakes: spelling and typos, grammar (tense, agreement, articles, prepositions, word order), a wrong word, a missing word.
Ignore all of these: capitalization (a lowercase "i" or sentence start is fine), punctuation style, apostrophes left out of contractions (lets, dont, im, thats), a casual tone, slang and short forms (smth, pls, u, btw, lol, etc), code, commands, file paths, identifiers, URLs, logs, and quoted or pasted text.
Keep the writer's voice: change as few words as possible, never rephrase for style.`
  const dialects = {
    any: 'Accept American and British spelling alike.',
    us: 'The writer uses American English: a British spelling (colour, organise) is a spelling mistake.',
    uk: 'The writer uses British English: an American spelling (color, organize) is a spelling mistake.',
  }
  const kindField = `, "kind": "<one of: ${KINDS.join(', ')}>"`
  const answer = `Answer with JSON only, no prose and no code fence:
{"english": true, "fixes": [{"from": "<exact words from the text>", "to": "<the fixed words>"${showWhy ? ', "why": "<2 to 4 words>"' : ''}${kind ? kindField : ''}}]}
"fixes" is [] when the English is fine. If the text is not mainly English, answer {"english": false, "fixes": []}.`
  const kindRule = `For "kind": article is a missing, extra or wrong a, an or the; missing word and extra word are for any other word.`
  const nat = `Also add "natural" to the JSON: null in most cases. Only when a native speaker would clearly say a sentence differently (an unidiomatic phrase, a word-for-word translation), even with the grammar fixed, give that one sentence the way a native speaker would say it: same meaning, same casual tone, the writer's own casing.
Never use "natural" for style taste, for a sentence that is fine once the fixes are applied, or for code.`
  const words = ignore.slice(0, 100)
  const never = words.length > 0 ? [`Never flag these, the writer means them as written: ${words.map(w => JSON.stringify(w)).join(', ')}.`] : []
  return [base, dialects[dialect], ...never, answer, ...(kind ? [kindRule] : []), ...(natural ? [nat] : [])].join('\n')
}

/** One /grammar prompt reply's text. */
const promptText = async ($: Engine, args = '') => (await $.command.run({ command: 'grammar', args: `prompt ${args}`.trim() } as never)).text ?? ''

/** A prompt file with the given sections, under a note that must never be sent. */
const sections = (parts: Record<string, string>) =>
  `<!-- NOTE-NOT-SENT -->\n\n${Object.entries(parts).map(([n, b]) => `## ${n}\n\n${b}\n`).join('\n')}`

test('system() with no overrides is main\'s prompt for every combination of settings', () => {
  const words = [[], ['kubectl'], ['a', 'b "q"'], Array.from({ length: 120 }, (_, i) => `w${i}`)]
  for (const natural of [true, false]) {
    for (const dialect of ['any', 'us', 'uk'] as const) {
      for (const showWhy of [true, false]) {
        for (const kind of [true, false]) {
          for (const ignore of words) {
            const p = { natural, dialect, showWhy, kind, ignore }
            expect(system(p)).toBe(legacySystem(p))
            expect(system(p, {})).toBe(legacySystem(p))
          }
        }
      }
    }
  }
  expect(system({ natural: true })).toBe(legacySystem({ natural: true }))
})

test('parsePromptFile: sections by heading, text above the first heading dropped, names forgiving', () => {
  const r = parsePromptFile('intro\n## not this\n\n<!-- hi -->\n\n##   Spelling   UK \nBritish.\nTwo lines.\n\n## rules\n  Mine.  \n')
  expect(r.parts).toEqual({ 'spelling uk': 'British.\nTwo lines.', rules: 'Mine.' })
  expect(r.problems).toHaveLength(1)
  expect(r.problems[0]).toContain('"## not this"')
  expect(r.problems[0]).toContain(PART_NAMES.join(', '))
  expect(parsePromptFile('').parts).toEqual({})
  expect(parsePromptFile('just text, no heading').problems).toEqual([])
  expect(parsePromptFile('##rules\nx').parts).toEqual({})
  expect(parsePromptFile('## RULES\r\nWindows.\r\n').parts).toEqual({ rules: 'Windows.' })
})

test('parsePromptFile: problems', () => {
  const dup = parsePromptFile('## rules\nOne.\n## rules\nTwo.\n')
  expect(dup.parts).toEqual({ rules: 'Two.' })
  expect(dup.problems).toEqual(['Section "## rules" appears twice; the last one is used.'])

  const empty = parsePromptFile('## rules\n   \n## kind\nK.')
  expect(empty.parts).toEqual({ kind: 'K.' })
  expect(empty.problems).toEqual(['Section "## rules" is empty, so the built-in text is used.'])

  expect(parsePromptFile('## ignore\nNever flag these.').problems).toEqual(['"## ignore" has no {words}, so your ignore words are not sent.'])
  expect(parsePromptFile('## ignore\nNever flag {words}.').problems).toEqual([])

  const answer = parsePromptFile('## answer\nJSON only.')
  expect(answer.problems).toHaveLength(2)
  expect(answer.problems[0]).toContain('{why}')
  expect(answer.problems[0]).toContain('show_why has no effect')
  expect(answer.problems[1]).toContain('{kind}')
  expect(answer.problems[1]).toContain('history')

  const marker = parsePromptFile('## rules\nUse {foo} here.\n## ignore\n{words} and {why}')
  expect(marker.problems).toHaveLength(2)
  expect(marker.problems[0]).toContain('{foo}')
  expect(marker.problems[0]).toContain('it has none')
  expect(marker.problems[1]).toContain('{why}')
  expect(marker.problems[1]).toContain('{words}')
  // JSON braces are not markers.
  expect(parsePromptFile(`## answer\n${BUILT_IN.answer}`).problems).toEqual([])
})

test('system(): an override replaces only its part, markers are filled, unknown ones stay', () => {
  const p = { natural: true, dialect: 'us', showWhy: false, kind: true, ignore: ['x$&y'] } as const
  const base = system(p)
  expect(system(p, { rules: 'R.' })).toBe(base.replace(BUILT_IN.rules, 'R.'))
  expect(system(p, { 'spelling uk': 'unused' })).toBe(base)
  expect(system(p, { ignore: 'Skip {words} {nope}.' })).toContain('Skip "x$&y" {nope}.')
  expect(system(p, { answer: 'A{why}|{kind}|' })).toContain('\nA|, "kind": "<one of: ')
  const never = 'Never flag these, the writer means them as written: "x$&y".'
  expect(system({ ...p, kind: false }, { answer: 'A{why}|{kind}|', kind: 'K' })).toBe([BUILT_IN.rules, BUILT_IN['spelling us'], never, 'A||', BUILT_IN.natural].join('\n'))
})

test('no prompt file: the built-in prompt, unchanged', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toBe(legacySystem(NOW_SYSTEM))
  expect(asked.systems[0]).toMatch(/^You proofread English that a non-native speaker typed/)
  const r = await promptText($)
  expect(r.startsWith('Prompt: built-in')).toBe(true)
  expect(r).toContain(legacySystem(NOW_SYSTEM))
  expect((await $.command.run({ command: 'grammar', args: 'help' } as never)).text).toContain('Prompt: built-in')
})

test('a blank prompt file, or one with no sections, counts as built-in', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, { [PROMPT_FILE]: ' \n\t\n' })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toBe(legacySystem(NOW_SYSTEM))
  expect(await promptText($)).toContain('Prompt: built-in')
  asked.files.set(PROMPT_FILE, 'only a note, sent nowhere')
  expect((await promptText($)).startsWith('Prompt: built-in')).toBe(true)
  expect((await $.command.run({ command: 'grammar', args: 'help' } as never)).text).toContain('Prompt: built-in')
})

test('/grammar prompt edit writes the note and every section, and changes nothing', { options: { dialect: 'us', show_why: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  const r = await promptText($, 'edit')
  expect(r).toContain(PROMPT_FILE)
  expect(r).toContain('changes apply to your next prompt')
  const file = asked.files.get(PROMPT_FILE) ?? ''
  expect(file.startsWith(PROMPT_HEADER)).toBe(true)
  expect(file).toBe(promptFileText())
  for (const n of PART_NAMES) {
    expect(file).toContain(`\n## ${n}\n`)
  }
  const parsed = parsePromptFile(file)
  expect(parsed.problems).toEqual([])
  expect(parsed.parts).toEqual(BUILT_IN)

  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toBe(legacySystem({ ...NOW_SYSTEM, dialect: 'us', showWhy: false }))
  const shown = await promptText($)
  expect(shown.startsWith('Prompt: yours\n')).toBe(true)
  for (const n of PART_NAMES) {
    expect(shown).toContain(`\n${n}: global (/home/u/.claude/grammar-prompt.md)\n`)
  }
  expect(shown).toContain(legacySystem({ ...NOW_SYSTEM, dialect: 'us', showWhy: false }))
  expect(shown).not.toContain('Problems')

  asked.files.set(PROMPT_FILE, 'mine')
  await promptText($, 'edit')
  expect(asked.files.get(PROMPT_FILE)).toBe('mine')
  expect(await promptText($, 'nonsense')).toContain('/grammar prompt')
})

test('one overridden section changes only that part; the file is read on every check', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, { [PROMPT_FILE]: sections({ rules: 'Flag only "appea".' }) })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toBe(legacySystem(NOW_SYSTEM).replace(BUILT_IN.rules, 'Flag only "appea".'))
  expect(asked.systems[0]).not.toContain('NOTE-NOT-SENT')
  asked.files.set(PROMPT_FILE, sections({ rules: 'Second.' }))
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(asked.systems[1]).toBe(legacySystem(NOW_SYSTEM).replace(BUILT_IN.rules, 'Second.'))
  const shown = await promptText($)
  expect(shown.startsWith('Prompt: yours\nrules: global (/home/u/.claude/grammar-prompt.md)\nspelling any: built-in\n')).toBe(true)
  expect((await $.command.run({ command: 'grammar', args: 'help' } as never)).text).toContain('Prompt: yours (/home/u/.claude/grammar-prompt.md)')
  asked.files.delete(PROMPT_FILE)
  await $.prompt.submit({ text: `${TYPO} third` } as never)
  await clock.advance(5)
  expect(asked.systems[2]).toBe(legacySystem(NOW_SYSTEM))
})

test('the spelling setting picks the spelling section', { options: { dialect: 'uk' } }, async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, {
    [PROMPT_FILE]: sections({ 'spelling any': 'ANY', 'spelling us': 'US', 'spelling uk': 'UK ONLY' }),
  })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toContain('\nUK ONLY\n')
  expect(asked.systems[0]).not.toMatch(/\nANY\n|\nUS\n/)
})

test('natural off drops the natural section even when the file has one', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, { [PROMPT_FILE]: sections({ natural: 'MY NATURAL ASK' }) })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toContain('MY NATURAL ASK')
  await $.command.run({ command: 'grammar', args: 'natural off' } as never)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(asked.systems[1]).not.toContain('MY NATURAL ASK')
  expect(await promptText($)).not.toContain('MY NATURAL ASK')
})

test('ignore words fill {words}; no ignore words, no ignore section', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, {
    [PROMPT_FILE]: sections({ ignore: 'Skip: {words}!' }),
    [HOME_FILE]: JSON.stringify({ ignore: ['kubectl', 'pnpm'] }),
  })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toContain('\nSkip: "kubectl", "pnpm"!\n')
  expect(asked.systems[0]).not.toContain('Never flag these')
  asked.files.set(HOME_FILE, '{}')
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(asked.systems[1]).not.toContain('Skip:')
})

test('show_why off empties {why}; history off empties {kind}', { options: { show_why: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, { [PROMPT_FILE]: sections({ answer: 'JSON: [{"to": ""{why}{kind}}]' }) })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toContain(`\nJSON: [{"to": "", "kind": "<one of: ${KINDS.join(', ')}>"}]\n`)
  await $.command.run({ command: 'grammar', args: 'history off' } as never)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(asked.systems[1]).toContain('\nJSON: [{"to": ""}]\n')
})

test('problems in the prompt file: one toast each, listed in /grammar prompt, checks go on with the built-in text', async ($, on) => {
  const clock = mock.clock(on)
  const file = [
    sections({ rules: 'Mine, with {mystery}.', 'bogus part': 'x', ignore: 'No marker.', kind: '' }),
    '## rules\n\nMine, with {mystery}.\n',
  ].join('\n')
  const asked = haiku(on, FIXES, undefined, { [PROMPT_FILE]: file, [HOME_FILE]: JSON.stringify({ ignore: ['kubectl'] }) })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  const sys = asked.systems[0] ?? ''
  expect(sys.startsWith('Mine, with {mystery}.\n')).toBe(true)
  expect(sys).toContain('No marker.')
  expect(sys).toContain(BUILT_IN.kind)
  expect(sys).not.toContain('kubectl')
  const ours = toasts.filter(t => t.startsWith('grammar: /home/u/.claude/grammar-prompt.md: '))
  expect(ours).toHaveLength(5)
  expect(ours.join('\n')).toContain('"## bogus part"')
  expect(ours.join('\n')).toContain('appears twice')
  expect(ours.join('\n')).toContain('{mystery}')
  expect(ours.join('\n')).toContain('has no {words}')
  expect(ours.join('\n')).toContain('"## kind" is empty')
  const shown = await promptText($)
  expect(shown).toContain('Problems:')
  expect(shown).toContain('- /home/u/.claude/grammar-prompt.md: Unknown section "## bogus part"')
  expect(shown).toContain('\nrules: global (/home/u/.claude/grammar-prompt.md)\n')
  expect(shown).toContain('\nignore: global (/home/u/.claude/grammar-prompt.md)\n')
  expect(shown).toContain('\nkind: built-in\n')
})

const PROJECT_PROMPT_FILE = '/work/app/.claude/grammar-prompt.md'

test('the header lists every section heading, and parses as no section', () => {
  for (const n of PART_NAMES) {
    expect(PROMPT_HEADER).toContain(`## ${n} `)
  }
  expect(parsePromptFile(PROMPT_HEADER)).toEqual({ parts: {}, problems: [] })
})

test('a project section beats a global one, which beats the built-in text', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, {
    [PROMPT_FILE]: sections({ rules: 'GLOBAL RULES', kind: 'GLOBAL KIND', natural: 'GLOBAL NATURAL' }),
    [PROJECT_PROMPT_FILE]: sections({ rules: 'PROJECT RULES', natural: 'PROJECT NATURAL' }),
  })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toBe(
    legacySystem(NOW_SYSTEM).replace(BUILT_IN.rules, 'PROJECT RULES').replace(BUILT_IN.kind, 'GLOBAL KIND').replace(BUILT_IN.natural, 'PROJECT NATURAL'),
  )
  const shown = await promptText($)
  expect(shown.startsWith('Prompt: yours\n')).toBe(true)
  expect(shown).toContain('\nrules: project (/work/app/.claude/grammar-prompt.md)\n')
  expect(shown).toContain('\nkind: global (/home/u/.claude/grammar-prompt.md)\n')
  expect(shown).toContain('\nanswer: built-in\n')
  expect(shown).toContain('\nnatural: project (/work/app/.claude/grammar-prompt.md)\n')
  expect((await $.command.run({ command: 'grammar', args: 'help' } as never)).text).toContain(
    'Prompt: yours (/home/u/.claude/grammar-prompt.md, /work/app/.claude/grammar-prompt.md)',
  )
})

test('settings still choose: natural off drops a project natural section', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, { [PROJECT_PROMPT_FILE]: sections({ natural: 'PROJECT NATURAL' }) })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toContain('PROJECT NATURAL')
  await $.command.run({ command: 'grammar', args: 'natural off' } as never)
  await $.prompt.submit({ text: `${TYPO} again` } as never)
  await clock.advance(5)
  expect(asked.systems[1]).not.toContain('PROJECT NATURAL')
  expect(asked.systems[1]).toBe(legacySystem({ natural: false, kind: true }))
})

test('/grammar prompt edit project writes the header only, and leaves an existing file alone', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES)
  const r = await promptText($, 'edit project')
  expect(r).toContain(PROJECT_PROMPT_FILE)
  expect(r).toContain('overrides nothing until you add a section')
  expect(r).toContain('part of the project')
  expect(asked.files.get(PROJECT_PROMPT_FILE)).toBe(`${PROMPT_HEADER}\n`)
  expect(asked.files.has(PROMPT_FILE)).toBe(false)
  expect(parsePromptFile(asked.files.get(PROJECT_PROMPT_FILE) ?? '')).toEqual({ parts: {}, problems: [] })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toBe(legacySystem(NOW_SYSTEM))
  expect(await promptText($)).toContain('Prompt: built-in\n')
  asked.files.set(PROJECT_PROMPT_FILE, 'mine')
  await promptText($, 'edit project')
  expect(asked.files.get(PROJECT_PROMPT_FILE)).toBe('mine')
  expect(await promptText($, 'edit elsewhere')).toContain('/grammar prompt')
})

test('a write that fails says so', async ($, on) => {
  haiku(on, FIXES)
  writeFails = 'ENOENT: no such directory'
  const r = await promptText($, 'edit project')
  expect(r).toContain('Could not write /work/app/.claude/grammar-prompt.md')
  expect(r).toContain('Could not write ')
})

test('problems in the project file carry its path; the global file keeps its own', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, FIXES, undefined, {
    [PROMPT_FILE]: sections({ 'bogus part': 'x' }),
    [PROJECT_PROMPT_FILE]: sections({ rules: '' }),
  })
  await $.prompt.submit({ text: TYPO } as never)
  await clock.advance(5)
  expect(asked.systems[0]).toBe(legacySystem(NOW_SYSTEM))
  expect(toasts.filter(t => t.startsWith('grammar: /work/app/.claude/grammar-prompt.md: '))).toHaveLength(1)
  expect(toasts.filter(t => t.startsWith('grammar: /home/u/.claude/grammar-prompt.md: '))).toHaveLength(1)
  const shown = await promptText($)
  expect(shown).toContain('- /work/app/.claude/grammar-prompt.md: Section "## rules" is empty')
  expect(shown).toContain('- /home/u/.claude/grammar-prompt.md: Unknown section "## bogus part"')
})
