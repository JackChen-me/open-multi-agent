/**
 * Shared keyword-affinity helpers used by capability-match scheduling
 * and short-circuit agent selection. Kept in one place so behaviour
 * can't drift between Scheduler and Orchestrator.
 */

export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'are', 'from', 'have',
  'will', 'your', 'you', 'can', 'all', 'each', 'when', 'then', 'they',
  'them', 'their', 'about', 'into', 'more', 'also', 'should', 'must',
])

const WORD_SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' })
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Tokenise `text` into a deduplicated set of lower-cased keywords.
 * CJK words shorter than 2 characters, non-CJK words shorter than 4
 * characters, and entries in {@link STOP_WORDS} are filtered out.
 */
export function extractKeywords(text: string): string[] {
  const keywords: string[] = []

  for (const { segment, isWordLike } of WORD_SEGMENTER.segment(text.toLowerCase())) {
    if (!isWordLike) continue

    // Preserve the previous \W+ splitting semantics for Latin-script words
    // while allowing Intl.Segmenter to surface CJK words instead of dropping them.
    const words = CJK_CHARACTER.test(segment) ? [segment] : segment.split(/\W+/)
    for (const word of words) {
      const meetsLengthThreshold = CJK_CHARACTER.test(word)
        ? [...word].length >= 2
        : word.length > 3
      if (meetsLengthThreshold && !STOP_WORDS.has(word)) {
        keywords.push(word)
      }
    }
  }

  return [...new Set(keywords)]
}

/**
 * Count how many `keywords` appear (case-insensitively) in `text`.
 * Each keyword contributes at most 1 to the score.
 */
export function keywordScore(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase()
  return keywords.reduce(
    (acc, kw) => acc + (lower.includes(kw.toLowerCase()) ? 1 : 0),
    0,
  )
}
