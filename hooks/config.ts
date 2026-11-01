// The settings and the ignore lists: plain functions, no engine calls.
import type { PluginOptions } from 'claude-code'

import type { GrammarFix } from '../types'

export type Dialect = 'any' | 'us' | 'uk'
export type Effort = 'low' | 'medium' | 'high'
export type DesktopMode = 'band' | 'line' | 'toast' | 'off'

/** The userConfig fields from plugin.json, as the module uses them. */
export type Settings = {
  enabled: boolean
  natural: boolean
  model: string
  effort: Effort
  dialect: Dialect
  minWords: number
  maxChars: number
  icons: boolean
  showWhy: boolean
  desktop: DesktopMode
  history: boolean
  clean: boolean
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

/** The options the engine hands `register`, with the manifest's defaults for anything missing or off-type. */
export const settingsFrom = (o: PluginOptions): Settings => ({
  enabled: o.enabled !== false,
  natural: o.natural !== false,
  model: typeof o.model === 'string' && o.model.trim() !== '' ? o.model : 'haiku',
  effort: pick(o.effort, ['low', 'medium', 'high'] as const, 'low'),
  dialect: pick(o.dialect, ['any', 'us', 'uk'] as const, 'any'),
  minWords: clamp(o.min_words, 1, 50, 2),
  maxChars: clamp(o.max_chars, 200, 20000, 6000),
  icons: o.icons !== false,
  showWhy: o.show_why !== false,
  desktop: pick(o.desktop, ['band', 'line', 'toast', 'off'] as const, 'band'),
  history: o.history !== false,
  clean: o.clean !== false,
})

/**
 * What a grammar.json holds: `ignore`, words or /regexes/ never flagged; `skip`, regexes of prompts never checked;
 * `history`, false to keep no fixes (a project that should leave no trace).
 */
export type Lists = { ignore: string[]; skip: string[]; history: boolean }

export const EMPTY: Lists = { ignore: [], skip: [], history: true }
const CAP = 200

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : []

/** A grammar.json's lists. Throws when the text is not a JSON object. */
export const parseLists = (text: string): Lists => {
  const raw = JSON.parse(text) as unknown
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not a JSON object')
  }
  const o = raw as Record<string, unknown>
  return { ignore: strings(o.ignore), skip: strings(o.skip), history: o.history !== false }
}

/** Lists from several files, joined without repeats, each capped. */
export const mergeLists = (...all: Lists[]): Lists => ({
  ignore: [...new Set(all.flatMap(l => l.ignore))].slice(0, CAP),
  skip: [...new Set(all.flatMap(l => l.skip))].slice(0, CAP),
  history: all.every(l => l.history),
})

const SLASHED = /^\/(.+)\/([a-z]*)$/

/** The regex an entry spells as /source/flags, null for a plain word, undefined when it does not compile. */
const regexOf = (entry: string, defaultFlags = ''): RegExp | null | undefined => {
  const m = SLASHED.exec(entry)
  if (m === null) {
    return null
  }
  const [, source = '', flags = ''] = m
  try {
    // No g or y: a stateful regex would answer differently on each test.
    return new RegExp(source, (flags || defaultFlags).replace(/[gy]/g, ''))
  } catch {
    return undefined
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A plain word or phrase as a case-insensitive whole-word match. */
const wordRegex = (word: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(word)}($|[^\\p{L}\\p{N}_])`, 'iu')

/** The ignore list compiled: plain words (also told to the model) and every entry as a regex. Bad regexes are dropped. */
export type Ignore = { words: string[]; matchers: RegExp[] }

export const compileIgnore = (entries: readonly string[]): Ignore => {
  const words: string[] = []
  const matchers: RegExp[] = []
  for (const entry of entries) {
    const re = regexOf(entry, 'i')
    if (re === null) {
      words.push(entry)
      matchers.push(wordRegex(entry))
    } else if (re !== undefined) {
      matchers.push(re)
    }
  }
  return { words, matchers }
}

export const isIgnored = (ignore: Ignore, s: string) => ignore.matchers.some(re => re.test(s))

/** The skip list compiled: each entry a regex, /slashes/ optional, case-insensitive unless flags say otherwise. */
export const compileSkip = (entries: readonly string[]): RegExp[] =>
  entries.flatMap(entry => {
    const re = regexOf(entry)
    if (re !== null) {
      return re === undefined ? [] : [re]
    }
    try {
      return [new RegExp(entry, 'i')]
    } catch {
      return []
    }
  })

/** The words of a prompt, for the minimum-words rule. */
export const wordCount = (text: string) => (text.match(/\p{L}+(['’]\p{L}+)*/gu) ?? []).length

/** The first `max` characters, cut at the last space when one is near, so no word is cut in half. */
export const cut = (text: string, max: number) => {
  if (text.length <= max) {
    return text
  }
  const head = text.slice(0, max)
  const space = head.search(/\s\S*$/)
  return space > max / 2 ? head.slice(0, space) : head
}

/** The prompt with each fix applied once, case-insensitively, in order. */
export const applyFixes = (text: string, fixes: readonly GrammarFix[]) =>
  fixes.reduce((t, f) => {
    const i = t.toLowerCase().indexOf(f.from.toLowerCase())
    return i < 0 ? t : t.slice(0, i) + f.to + t.slice(i + f.from.length)
  }, text)

/** Entries from `/grammar ignore add|rm`: phrases split on commas when there are any, else words split on spaces. */
export const entriesFrom = (args: string) =>
  (args.includes(',') ? args.split(',') : args.split(/\s+/)).map(s => s.trim()).filter(s => s !== '')
