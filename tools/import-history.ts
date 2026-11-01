// Fills grammar-history.json from your past sessions: finds the prompts you typed in the last N days in Claude Code's
// transcripts, checks them with the plugin's own prompt (in batches, through `claude -p` on your login), and adds
// their fixes with the time each prompt was sent.
//
//   bun tools/import-history.ts                 the last 7 days
//   bun tools/import-history.ts --days 30       up to 90, what the history keeps
//   bun tools/import-history.ts --dry-run       count the prompts, ask the model nothing
//   bun tools/import-history.ts --config-dir ~/.claude-work
//
// Only days before the history's first day are imported, so a second run adds nothing twice.
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { GrammarFix } from '../types'
import { BATCH, keepFixes, parseBatch, parsePromptFile, system, typedPart } from '../hooks/check'
import type { Overrides } from '../hooks/check'
import { EMPTY, compileIgnore, compileSkip, cut, mergeLists, parseLists, settingsFrom, wordCount } from '../hooks/config'
import type { Lists, Settings } from '../hooks/config'
import { EMPTY_HISTORY, KEEP_DAYS, dayOf, historyText, importWindow, merge, parseHistory, record } from '../hooks/history'
import type { History } from '../hooks/history'
import { batches, typedText } from './transcript'
import type { Prompt } from './transcript'

const PARALLEL = 4
// One call that takes longer than this is stopped and counted as failed.
const CALL_TIMEOUT_MS = 180_000

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const dryRun = args.includes('--dry-run')
const configDir = (flag('--config-dir') ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).replace(/^~(?=\/)/, homedir())
const historyPath = join(configDir, 'grammar-history.json')

const fail = (text: string): never => {
  console.error(text)
  process.exit(1)
}

const days = Number(flag('--days') ?? 7)
if (!Number.isInteger(days) || days < 1 || days > KEEP_DAYS) {
  fail(`--days takes a whole number from 1 to ${KEEP_DAYS}, the days the history keeps.`)
}

/** The plugin's settings as /config saved them, else its defaults. */
const loadSettings = (): Settings => {
  try {
    const all = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { pluginConfigs?: Record<string, { options?: object }> }
    const key = Object.keys(all.pluginConfigs ?? {}).find(k => k.split('@')[0] === 'grammar')
    return settingsFrom((key === undefined ? {} : all.pluginConfigs?.[key]?.options ?? {}) as never)
  } catch {
    return settingsFrom({})
  }
}

/** The parts grammar-prompt.md overrides, as the plugin reads them; none when it is missing, unreadable or blank. */
const customParts = (): Overrides => {
  try {
    return parsePromptFile(readFileSync(join(configDir, 'grammar-prompt.md'), 'utf8')).parts
  } catch {
    return {}
  }
}

const listsCache = new Map<string, Lists>()
/** A grammar.json's lists; empty when it is missing or does not parse (the plugin says so when it runs). */
const readLists = (path: string): Lists => {
  if (!listsCache.has(path)) {
    let lists = EMPTY
    try {
      lists = existsSync(path) ? parseLists(readFileSync(path, 'utf8')) : EMPTY
    } catch {
      console.error(`  ${path} does not parse; read as empty`)
    }
    listsCache.set(path, lists)
  }
  return listsCache.get(path) ?? EMPTY
}

/** The prompts you typed between `from` and `to`, oldest first, each once, filtered as the plugin filters them. */
const findPrompts = async (from: number, to: number, s: Settings): Promise<{ prompts: Prompt[]; skipped: number }> => {
  const root = join(configDir, 'projects')
  if (!existsSync(root)) {
    fail(`No transcripts in ${root}.`)
  }
  const files = readdirSync(root).flatMap(dir => {
    const d = join(root, dir)
    return statSync(d).isDirectory() ? readdirSync(d).filter(f => f.endsWith('.jsonl')).map(f => join(d, f)) : []
  })
  const seen = new Set<string>()
  const found: Omit<Prompt, 'id'>[] = []
  let skipped = 0
  for (const file of files.filter(f => statSync(f).mtimeMs >= from)) {
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      const p = typedText(line)
      // A resumed or forked session copies its lines: each message once, by its id.
      if (p === undefined || p.at < from || p.at >= to || (p.uuid !== '' && seen.has(p.uuid))) {
        continue
      }
      seen.add(p.uuid)
      const text = typedPart(p.text.trim())
      // Slash commands, and lines Claude Code wraps in tags (command output, ! shell input); pasted text is checked as the plugin checks it.
      const tagged = text.startsWith('<') && !text.startsWith('<pasted_content')
      if (text.startsWith('/') || tagged || !/[A-Za-z]{2}/.test(text) || wordCount(text) < s.minWords) {
        continue
      }
      const lists = mergeLists(readLists(join(configDir, 'grammar.json')), readLists(join(p.cwd, '.claude', 'grammar.json')))
      if (!lists.history || compileSkip(lists.skip).some(re => re.test(text))) {
        skipped += 1
        continue
      }
      found.push({ text, at: p.at, cwd: p.cwd })
    }
  }
  found.sort((a, b) => a.at - b.at)
  return { prompts: found.map((p, id) => ({ ...p, id })), skipped }
}

// An empty folder to run the calls in, so no project's CLAUDE.md or settings ride along.
const callDir = mkdtempSync(join(tmpdir(), 'grammar-import-'))
// Your config folder; without CLAUDECODE, which marks a run inside Claude Code and may stop a nested claude -p.
const childEnv = Object.fromEntries(Object.entries({ ...process.env, CLAUDE_CONFIG_DIR: configDir }).filter(([k]) => k !== 'CLAUDECODE'))

/**
 * One `claude -p` call on your login: safe mode (no CLAUDE.md, plugins, hooks or MCP servers), no tools, no saved
 * session. The reply's text and cost.
 */
const complete = (sys: string, prompt: string, s: Settings): Promise<{ text: string; cost: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--safe-mode',
        '--model', s.model,
        '--effort', s.effort,
        '--system-prompt', sys,
        '--tools', '',
        '--no-session-persistence',
        '--output-format', 'json',
      ],
      { cwd: callDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out) as { result?: string; is_error?: boolean; total_cost_usd?: number }
        if (code !== 0 || j.is_error === true || typeof j.result !== 'string') {
          throw new Error(j.result ?? `exit ${code}`)
        }
        resolve({ text: j.result, cost: j.total_cost_usd ?? 0 })
      } catch (e) {
        reject(new Error(`claude -p failed: ${e instanceof Error ? e.message : String(e)} ${err.trim()}`.trim()))
      }
    })
    child.stdin.end(prompt)
  })

const main = async () => {
  const s = loadSettings()
  if (!s.history) {
    fail('The history is off in your settings (/grammar history on turns it on); nothing imported.')
  }
  let existing = EMPTY_HISTORY
  if (existsSync(historyPath)) {
    try {
      existing = parseHistory(readFileSync(historyPath, 'utf8'))
    } catch (e) {
      fail(`${historyPath} does not parse (${e instanceof Error ? e.message : String(e)}); fix it or run /grammar history clear first.`)
    }
  }
  // Days the history already counts were checked live: import only whole days before them.
  const first = existing.days[0]?.day
  const span = importWindow(Date.now(), days, first)
  if (span === undefined) {
    console.log(`The history already covers the last ${days} days (from ${first}); nothing to import.`)
    return
  }
  const { from, to } = span
  const { prompts, skipped } = await findPrompts(from, to, s)
  const calls = batches(prompts)
  console.log(
    `${prompts.length} prompts typed from ${dayOf(from)} to ${first === undefined ? 'now' : `the end of ${dayOf(to - 1)}`} (UTC) in ${configDir}` +
      `${skipped > 0 ? ` (${skipped} more skipped by skip lists or "history": false)` : ''}; ${calls.length} calls to ${s.model}.`,
  )
  if (dryRun || prompts.length === 0) {
    return
  }

  const global = readLists(join(configDir, 'grammar.json'))
  const sys = `${system({ natural: false, dialect: s.dialect, showWhy: s.showWhy, kind: true, ignore: compileIgnore(global.ignore).words }, customParts())}\n${BATCH}`
  const results = new Map<number, GrammarFix[] | null>()
  let cost = 0
  let done = 0
  /** The replies for these prompts by id; a failed call twice in a row gives none. */
  const ask = async (batch: Prompt[]) => {
    const input = JSON.stringify(batch.map(p => ({ id: p.id, text: cut(p.text, s.maxChars) })))
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await complete(sys, input, s)
        cost += r.cost
        const replies = parseBatch(r.text)
        // A reply that answers none of the texts is a failed call: asked again.
        if (replies.size === 0) {
          throw new Error(`no usable answer: ${r.text.slice(0, 120)}`)
        }
        return replies
      } catch (e) {
        if (attempt === 1) {
          console.error(`\n  a call failed twice, ${batch.length} prompts left out: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    return new Map<number, unknown>()
  }
  const queue = [...calls]
  const worker = async () => {
    for (let batch = queue.shift(); batch !== undefined; batch = queue.shift()) {
      const replies = await ask(batch)
      // Prompts the reply skipped get one more call of their own.
      const missing = batch.filter(p => !replies.has(p.id))
      if (missing.length > 0 && missing.length < batch.length) {
        for (const [id, r] of await ask(missing)) {
          replies.set(id, r)
        }
      }
      for (const p of batch) {
        const reply = replies.get(p.id) as { fixes: GrammarFix[] } | null | undefined
        if (reply === undefined) {
          continue
        }
        const lists = mergeLists(global, readLists(join(p.cwd, '.claude', 'grammar.json')))
        results.set(p.id, reply === null ? null : keepFixes(reply.fixes, p.text, compileIgnore(lists.ignore)))
      }
      done += 1
      process.stdout.write(`\r  ${done}/${calls.length} calls`)
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  process.stdout.write('\n')

  // English that was checked counts, clean or not, as the plugin counts it; other languages do not.
  let imported = EMPTY_HISTORY
  for (const p of prompts) {
    const fixes = results.get(p.id)
    if (fixes !== undefined && fixes !== null) {
      imported = record(imported, fixes, p.at)
    }
  }
  // Read again just before writing: a live session may have added to it meanwhile, or be writing it this moment.
  let latest: History = existing
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      latest = existsSync(historyPath) ? parseHistory(readFileSync(historyPath, 'utf8')) : EMPTY_HISTORY
      break
    } catch {
      await new Promise(r => setTimeout(r, 200))
    }
  }
  // Written whole beside it, then moved over it in one step, so a session reading meanwhile never sees half a file.
  const temp = `${historyPath}.import-${process.pid}`
  writeFileSync(temp, historyText(merge(imported, latest, Date.now())))
  renameSync(temp, historyPath)

  const checked = imported.days.reduce((n, d) => n + d.checked, 0)
  const withFixes = imported.days.reduce((n, d) => n + d.withFixes, 0)
  const notEnglish = [...results.values()].filter(r => r === null).length
  const failed = prompts.length - results.size
  console.log(
    `${checked} prompts in English checked, ${withFixes} with a fix, ${imported.fixes.length} fixes kept; ` +
      `${notEnglish} not in English${failed > 0 ? `, ${failed} left out (no usable answer)` : ''}. Cost about $${cost.toFixed(3)}.\n` +
      `Written to ${historyPath}. /grammar stats shows them.`,
  )
}

await main()
