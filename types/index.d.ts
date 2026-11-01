// `why` is '' when the show_why setting is off. `kind` is what the fix corrects, asked for while the history is on.
export type GrammarFix = { from: string; to: string; why: string; kind?: string }
export type GrammarReply = { fixes: GrammarFix[]; natural: string | null }
export type GrammarCheck = {
  id: number
  // The prompt as typed, trimmed.
  text: string
  status: 'checking' | 'done' | 'error'
  fixes: GrammarFix[]
  // How a native speaker would say it, when the phrasing is clearly off.
  natural?: string | null
  error?: string
  // This failure paused the checks: too many in a row.
  paused?: boolean
  // Clean prompts in a row, this one included; set only on a clean check.
  streak?: number
}

/** The figures at the top of a review (hooks/history.ts builds them as its Summary). */
export type GrammarSummary = {
  label: string
  range: string
  checked: number
  withFixes: number
  fixes: number
  trend?: { recent: number; before: number; fewer: boolean | null; text: string }
  kinds: { kind: string; n: number; share: number }[]
  top?: { from: string; to: string; kind: string; why: string; count: number }
}
/** A review shown this session: the row's text, and what the panel above the advice draws from. */
export type GrammarReview = { text: string; summary: GrammarSummary; advice: string; model: string }

declare module 'claude-code' {
  interface PluginState {
    grammar: {
      grammarOn: boolean
      grammarNatural: boolean
      // Fixes are kept in grammar-history.json for /grammar stats and /grammar review.
      grammarHistory: boolean
      // Reviews shown this session, newest first, so their rows can draw the panel.
      grammarReviews: GrammarReview[]
      grammarChecks: GrammarCheck[]
      grammarLastId: number
      // Failed checks in a row; at MAX_FAILS the checks pause until /grammar on.
      grammarFails: number
      // The id of the check whose band was hidden in the desktop app.
      grammarHiddenId: number
      // Clean checks in a row this session; a check with a fix resets it.
      grammarStreak: number
    }
  }
}
