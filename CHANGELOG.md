# Changelog

Each version is tagged `vX.Y.Z` and has a [GitHub release](https://github.com/jaklimoff/claude-grammar/releases) with its section below as the notes. Bump `version` in `.claude-plugin/plugin.json` on every change to what ships: installed copies update only when it changes. How releases work: [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-releases).

## 1.5.0 (2026-11-01)

- Your own prompt, part by part. `grammar-prompt.md` in your Claude Code folder holds `## name` sections (`rules`, `spelling any|us|uk`, `ignore`, `answer`, `kind`, `natural`); each replaces that part of the built-in prompt, and a part with no section keeps the built-in text. Delete a section for its default, or the file for the built-in prompt. It is read on every check, so edits apply to your next prompt.
- Your settings still choose which parts are sent: the spelling setting picks the spelling section, `ignore` goes only with ignore words (`{words}`), `answer` fills `{why}` and `{kind}` from `show_why` and history, `kind` only with history, `natural` only with the native-speaker line. Text above the first heading is never sent.
- A problem in the file (unknown or repeated heading, empty section, missing `{words}`, `{why}` or `{kind}`, unknown `{marker}`) never stops a check: it shows as a toast once, and the part falls back to the built-in text.
- `/grammar prompt` says which prompt is in use and which sections the file overrides, lists problems, and prints the prompt your settings put together. `/grammar prompt edit` writes the file with a note and every section, if it doesn't exist. `/grammar help` has a `Prompt:` line.
- `tools/import-history.ts` uses the file too, followed by its batch instructions.
- Without the file the prompt is unchanged, so the costs in the README are too.

## 1.4.0 (2026-10-31)

- A prompt with no mistakes gets a green check before it. From 3 clean prompts in a row, a line under it says how many (`3 in a row`). A fix or a native-speaker line starts the count over; a failed check or another language leaves it as it is. The count is for the session.
- In the desktop app the band shows `✓ No mistakes` (and the count) for a clean prompt instead of going blank. With `desktop` set to `line` it is a transcript line, with `toast` a short toast; `band` adds no transcript line for it.
- A `clean` setting (on by default) turns it off.

## 1.3.0 (2026-10-30)

- The desktop app doesn't draw the line under the prompt, so a check's fixes never showed there. Now the newest check shows in color in a band above the prompt box, drawn like the line under the prompt in the terminal, but with plain icons and one row per fix. A small Hide button hides it until the next check finishes; a clean check shows nothing.
- Each check there also adds a dim line to the transcript, as the record of past checks. A failed check says why.
- A `desktop` setting: `band` (the default: the band plus the transcript line), `line` for the transcript line alone, `toast` to show the fixes briefly as a toast instead, or `off`. The terminal is unchanged.

## 1.2.0 (2026-10-30)

- Your mistakes over time. Each fix is kept in `grammar-history.json` in your Claude Code folder, labeled with the kind of mistake (article, preposition, tense, ...). The history holds 90 days and up to 2000 fixes. Fixes that look like code or paths aren't kept, and neither are prompts or the native-speaker line. The first session that keeps fixes starts with a notice naming the file, once. A file cut short while it is written keeps the lines that still parse, the day counts first.
- `/grammar stats` and `/grammar review` take a period: `7d`, `30d` or `since 2026-10-01`; the trend compares it with the stretch before it of the same length.
- `/grammar stats`: mistakes by kind, the fixes you repeat, and the share of prompts with a fix in the last 30 days against the 30 before. No model call.
- `/grammar review`: a summary card (the period's prompts, share with a fix, trend, top kinds as bars, most repeated fix), then one Sonnet call's 3 to 5 habits to work on, with your own fixes as examples drawn like the fixes under a prompt. It needs 20 fixes in the period and falls back to your `model` setting when Sonnet isn't allowed or the API says it isn't available.
- `tools/import-history.ts` fills the history from the prompts in your past transcripts: `--days N`, the same days as the period `Nd` (default 7, up to 90), and `--dry-run`. It runs through `claude -p --safe-mode` on your own login, about 20 prompts per call, and never imports a day twice.
- `/grammar history on|off|clear`, a `history` setting, and `"history": false` in a project's `grammar.json` to keep nothing from that project.
- The check asks the model for each fix's kind while the history is on: 82 more input tokens per check (602 instead of 520 for a clean prompt, measured).
- PRIVACY.md and the README say what is kept on disk and what the review sends.
- The README opens with an animated tour of every feature (fixes, the native-speaker line, stats, review, ignore and settings, import) in light and dark, in place of the demo GIF. `docs/tour.html` is its source and `docs/render-tour.ts` records it; the VHS tape is gone.

## 1.1.0 (2026-10-30)

- Settings under `/config`: model, effort, spelling (any, US, UK), minimum words, maximum characters, plain icons, and whether to show the reason for each fix. The two `/grammar` switches are settings now; 1.0's saved switches move over on the first start.
- Ignore and skip lists in `~/.claude/grammar.json` and a project's `.claude/grammar.json`, plus `/grammar ignore add|rm|list`.
- Checks pause after 3 failures in a row (a blocked model, an outage) instead of failing on every prompt; `/grammar on` resumes.
- Fixes for words the prompt doesn't contain are dropped.
- A prompt no longer shows the fixes of a shorter prompt it starts with.
- Long prompts are cut at a word boundary. The model no longer repeats the whole sentence for each fix, which leaves room in the reply and saves output tokens.
- `/grammar help` lists the commands and shows what is on now; `/grammar` with an unknown word prints the same list instead of toggling.
- The privacy note says pasted text is sent too.

## 1.0.3 (2026-10-30)

A privacy note (PRIVACY.md), and homepage, docs, support and privacy links in plugin.json.

## 1.0.2 (2026-10-30)

Code reads the way the plugin directory's checks expect; the demo GIF moved to the `media` branch.

## 1.0.1 (2026-10-30)

An icon, and the descriptions say each prompt goes to Haiku.

## 1.0.0 (2026-10-29)

First public release: Haiku checks each prompt, the fixes and a native-speaker rewrite show under it, `/grammar` switches both.
