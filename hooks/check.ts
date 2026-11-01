// The check itself: the system prompt, the reply's parsing and the fixes worth keeping. Plain functions, no engine
// calls, so tools/import-history.ts can check old prompts exactly as the plugin checks new ones.
import type { GrammarFix, GrammarReply } from '../types'
import { isIgnored } from './config'
import type { Dialect, Ignore } from './config'
import { KINDS, kindOf } from './history'

// Plain ignore words told to the model; the local filter still drops fixes for all of them.
const MAX_PROMPT_WORDS = 100

const BASE = `You proofread English that a non-native speaker typed as a prompt to a coding assistant.
Report only real mistakes: spelling and typos, grammar (tense, agreement, articles, prepositions, word order), a wrong word, a missing word.
Ignore all of these: capitalization (a lowercase "i" or sentence start is fine), punctuation style, apostrophes left out of contractions (lets, dont, im, thats), a casual tone, slang and short forms (smth, pls, u, btw, lol, etc), code, commands, file paths, identifiers, URLs, logs, and quoted or pasted text.
Keep the writer's voice: change as few words as possible, never rephrase for style.`

const DIALECT: Record<Dialect, string> = {
  any: 'Accept American and British spelling alike.',
  us: 'The writer uses American English: a British spelling (colour, organise) is a spelling mistake.',
  uk: 'The writer uses British English: an American spelling (color, organize) is a spelling mistake.',
}

const KIND = `, "kind": "<one of: ${KINDS.join(', ')}>"`

const answer = (showWhy: boolean, kind: boolean) => `Answer with JSON only, no prose and no code fence:
{"english": true, "fixes": [{"from": "<exact words from the text>", "to": "<the fixed words>"${showWhy ? ', "why": "<2 to 4 words>"' : ''}${kind ? KIND : ''}}]}
"fixes" is [] when the English is fine. If the text is not mainly English, answer {"english": false, "fixes": []}.`

const KIND_RULE = `For "kind": article is a missing, extra or wrong a, an or the; missing word and extra word are for any other word.`

const NATURAL = `Also add "natural" to the JSON: null in most cases. Only when a native speaker would clearly say a sentence differently (an unidiomatic phrase, a word-for-word translation), even with the grammar fixed, give that one sentence the way a native speaker would say it: same meaning, same casual tone, the writer's own casing.
Never use "natural" for style taste, for a sentence that is fine once the fixes are applied, or for code.`

export type PromptParts = { natural: boolean; dialect?: Dialect; showWhy?: boolean; kind?: boolean; ignore?: readonly string[] }

/**
 * The system prompt: the rules, the spelling, the user's ignore words, the answer's shape (with each fix's kind while
 * the history is on), and the natural-phrasing ask when it is on.
 */
export const system = ({ natural, dialect = 'any', showWhy = true, kind = true, ignore = [] }: PromptParts) => {
  const words = ignore.slice(0, MAX_PROMPT_WORDS)
  const never =
    words.length > 0 ? [`Never flag these, the writer means them as written: ${words.map(w => JSON.stringify(w)).join(', ')}.`] : []
  return [BASE, DIALECT[dialect], ...never, answer(showWhy, kind), ...(kind ? [KIND_RULE] : []), ...(natural ? [NATURAL] : [])].join('\n')
}

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
