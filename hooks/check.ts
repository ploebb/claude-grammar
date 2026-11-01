// The check itself: the system prompt, the reply's parsing and the fixes worth keeping. Plain functions, no engine
// calls, so tools/import-history.ts can check old prompts exactly as the plugin checks new ones.
import type { GrammarFix, GrammarReply } from '../types'
import { isIgnored } from './config'
import type { Dialect, Ignore } from './config'
import { KINDS, kindOf } from './history'

// Plain ignore words told to the model; the local filter still drops fixes for all of them.
const MAX_PROMPT_WORDS = 100

const RULES = `You proofread English that a non-native speaker typed as a prompt to a coding assistant.
Report only real mistakes: spelling and typos, grammar (tense, agreement, articles, prepositions, word order), a wrong word, a missing word.
Ignore all of these: capitalization (a lowercase "i" or sentence start is fine), punctuation style, apostrophes left out of contractions (lets, dont, im, thats), a casual tone, slang and short forms (smth, pls, u, btw, lol, etc), code, commands, file paths, identifiers, URLs, logs, and quoted or pasted text.
Keep the writer's voice: change as few words as possible, never rephrase for style.`

const ANSWER = `Answer with JSON only, no prose and no code fence:
{"english": true, "fixes": [{"from": "<exact words from the text>", "to": "<the fixed words>"{why}{kind}}]}
"fixes" is [] when the English is fine. If the text is not mainly English, answer {"english": false, "fixes": []}.`

/** The parts of the system prompt, by the name of their `## ` section in grammar-prompt.md. */
export const PART_NAMES = ['rules', 'spelling any', 'spelling us', 'spelling uk', 'ignore', 'answer', 'kind', 'natural'] as const
export type PartName = (typeof PART_NAMES)[number]
export type Overrides = Partial<Record<PartName, string>>

/** The built-in text of each part, with its {markers}. */
export const BUILT_IN: Record<PartName, string> = {
  rules: RULES,
  'spelling any': 'Accept American and British spelling alike.',
  'spelling us': 'The writer uses American English: a British spelling (colour, organise) is a spelling mistake.',
  'spelling uk': 'The writer uses British English: an American spelling (color, organize) is a spelling mistake.',
  ignore: 'Never flag these, the writer means them as written: {words}.',
  answer: ANSWER,
  kind: `For "kind": article is a missing, extra or wrong a, an or the; missing word and extra word are for any other word.`,
  natural: `Also add "natural" to the JSON: null in most cases. Only when a native speaker would clearly say a sentence differently (an unidiomatic phrase, a word-for-word translation), even with the grammar fixed, give that one sentence the way a native speaker would say it: same meaning, same casual tone, the writer's own casing.
Never use "natural" for style taste, for a sentence that is fine once the fixes are applied, or for code.`,
}

/** The {markers} each part fills in; any other part has none. */
const MARKERS: Partial<Record<PartName, readonly string[]>> = { ignore: ['words'], answer: ['why', 'kind'] }

const MARKER = /\{([A-Za-z_][\w ]*)\}/g

/** The text with its known {markers} replaced; unknown ones stay as written. */
const fill = (text: string, values: Record<string, string>) =>
  text.replace(MARKER, (m, k: string) => (Object.hasOwn(values, k) ? (values[k] ?? m) : m))

export type PromptParts = { natural: boolean; dialect?: Dialect; showWhy?: boolean; kind?: boolean; ignore?: readonly string[] }

/**
 * The system prompt: the rules, the spelling, the user's ignore words, the answer's shape (with each fix's kind while
 * the history is on), and the natural-phrasing ask when it is on. A part in `over` replaces its built-in text.
 */
export const system = ({ natural, dialect = 'any', showWhy = true, kind = true, ignore = [] }: PromptParts, over: Overrides = {}) => {
  const part = (name: PartName) => over[name] ?? BUILT_IN[name]
  const words = ignore.slice(0, MAX_PROMPT_WORDS)
  const never = words.length > 0 ? [fill(part('ignore'), { words: words.map(w => JSON.stringify(w)).join(', ') })] : []
  const shape = fill(part('answer'), {
    why: showWhy ? ', "why": "<2 to 4 words>"' : '',
    kind: kind ? `, "kind": "<one of: ${KINDS.join(', ')}>"` : '',
  })
  return [part('rules'), part(`spelling ${dialect}`), ...never, shape, ...(kind ? [part('kind')] : []), ...(natural ? [part('natural')] : [])].join('\n')
}

/** What grammar-prompt.md holds: the parts it overrides, and what is wrong with it (short, for the user). */
export type ParsedPrompt = { parts: Overrides; problems: string[] }

const normal = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

/** The sections of grammar-prompt.md: text before the first `## ` line is ignored; problems never stop a check. */
export const parsePromptFile = (text: string): ParsedPrompt => {
  const parts: Overrides = {}
  const problems: string[] = []
  const seen = new Set<string>()
  const sections: { name: string; body: string[] }[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      sections.push({ name: line.slice(3), body: [] })
    } else {
      sections.at(-1)?.body.push(line)
    }
  }
  for (const { name: raw, body } of sections) {
    const name = normal(raw)
    const shown = `## ${raw.trim()}`
    if (!(PART_NAMES as readonly string[]).includes(name)) {
      problems.push(`Unknown section "${shown}" is ignored. Valid: ${PART_NAMES.join(', ')}.`)
      continue
    }
    const part = name as PartName
    if (seen.has(part)) {
      problems.push(`Section "${shown}" appears twice; the last one is used.`)
    }
    seen.add(part)
    const content = body.join('\n').trim()
    if (content === '') {
      delete parts[part]
      problems.push(`Section "${shown}" is empty, so the built-in text is used.`)
      continue
    }
    parts[part] = content
    const known = MARKERS[part] ?? []
    for (const m of new Set([...content.matchAll(MARKER)].map(x => x[1] ?? ''))) {
      if (!known.includes(m)) {
        problems.push(`"${shown}" has {${m}}, which is not a marker there (${known.length === 0 ? 'it has none' : known.map(k => `{${k}}`).join(', ')}); it is sent as written.`)
      }
    }
    if (part === 'ignore' && !content.includes('{words}')) {
      problems.push(`"${shown}" has no {words}, so your ignore words are not sent.`)
    }
    if (part === 'answer') {
      if (!content.includes('{why}')) {
        problems.push(`"${shown}" has no {why}, so show_why has no effect.`)
      }
      if (!content.includes('{kind}')) {
        problems.push(`"${shown}" has no {kind}, so history adds no kind to the fixes.`)
      }
    }
  }
  return { parts, problems }
}

/** The explanatory note at the top of a new grammar-prompt.md (hidden in Markdown viewers, never sent). */
export const PROMPT_HEADER = `<!--
grammar: your check prompt. Each "## name" section below replaces that part of the built-in prompt.
Delete a section to use the built-in text for it again; delete this file to go back to the built-in prompt entirely.
Keep the headings as they are: an unknown heading is ignored (/grammar prompt and a toast tell you).

Which parts are sent depends on your settings:
  rules                 always
  spelling any|us|uk    the one your spelling setting picks
  ignore                only when you have ignore words; {words} is replaced by them
  answer                always; {why} and {kind} add those fields when show_why / history are on
  kind                  only when history is on
  natural               only when the native-speaker line is on
The plugin reads the reply as JSON in the shape "answer" describes; if you change that shape, checks fail.
/grammar prompt shows the prompt your settings put together from this file.
Text above the first heading (like this note) is not sent.
-->`

/** A new grammar-prompt.md: the note, then every part with its built-in text. */
export const promptFileText = () => `${PROMPT_HEADER}\n\n${PART_NAMES.map(n => `## ${n}\n\n${BUILT_IN[n]}\n`).join('\n')}`

const isFix = (x: unknown): x is GrammarFix => {
  const f = x as Record<string, unknown>
  return typeof f?.from === 'string' && typeof f.to === 'string'
}

/** The reply as fixes and a natural rewrite, or null when the text is not English. Throws on a reply that is not the JSON asked for. */
export const parseReply = (text: string): GrammarReply | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new Error('no JSON in the reply')
  }
  const reply = JSON.parse(text.slice(start, end + 1)) as { english?: unknown; fixes?: unknown; natural?: unknown }
  if (reply.english === false) {
    return null
  }
  if (!Array.isArray(reply.fixes)) {
    throw new Error('no fixes in the reply')
  }
  const fixes = reply.fixes
    .filter(isFix)
    .filter(f => f.from.trim() !== f.to.trim())
    .map(f => ({ from: f.from, to: f.to, why: typeof f.why === 'string' ? f.why : '', kind: kindOf(f.kind) }))
  const natural = typeof reply.natural === 'string' && reply.natural.trim() !== '' ? reply.natural.trim() : null
  return { fixes, natural }
}

/** The fixes worth showing: words the prompt holds (the model may quote words that are not there), none on the ignore list. */
export const keepFixes = (fixes: readonly GrammarFix[], text: string, ignore: Ignore) => {
  const lower = text.toLowerCase()
  return fixes.filter(f => f.from.trim() !== '' && lower.includes(f.from.toLowerCase()) && !isIgnored(ignore, f.from))
}

// Answers sent by the open-questions plugin (github.com/jaklimoff/claude-open-questions) quote Claude's own words: not checked.
const ANSWERS = /(^|\n\n)Answers? to your question/

/** The part of a prompt you typed: without the answers open-questions may have appended. */
export const typedPart = (text: string) => {
  const m = ANSWERS.exec(text)
  return (m === null ? text : text.slice(0, m.index)).trim()
}

/** Added to the system prompt when one call checks several old prompts at once (tools/import-history.ts). */
export const BATCH = `This time the message holds several texts, as a JSON array of {"id": <number>, "text": "..."}. Check each text on its own, as if it were the only one.
Answer with a JSON array only, no prose and no code fence: one object per text, in the shape above plus its "id", like [{"id": 1, "english": true, "fixes": []}].`

/**
 * A batch reply as each text's reply by id (null: not English). Texts the reply leaves out or garbles are missing. A
 * lone object, as a model may answer a batch of one, counts as that one item. Throws when there is no JSON.
 */
export const parseBatch = (text: string): Map<number, GrammarReply | null> => {
  const open = text.indexOf('[')
  const brace = text.indexOf('{')
  // The first bracket says the shape: `[` an array, `{` one object (whose own arrays come later).
  const lone = brace >= 0 && (open < 0 || brace < open)
  const [start, end] = lone ? [brace, text.lastIndexOf('}')] : [open, text.lastIndexOf(']')]
  if (start < 0 || end < start) {
    throw new Error('no JSON in the reply')
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
  const items = lone ? [parsed] : parsed
  if (!Array.isArray(items)) {
    throw new Error('not a JSON array')
  }
  const out = new Map<number, GrammarReply | null>()
  for (const item of items) {
    const id = (item as { id?: unknown })?.id
    if (typeof id !== 'number') {
      continue
    }
    try {
      out.set(id, parseReply(JSON.stringify(item)))
    } catch {
      // This one text's answer is unusable; the rest stand.
    }
  }
  return out
}
