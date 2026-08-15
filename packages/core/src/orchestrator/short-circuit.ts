/**
 * @fileoverview Short-circuit helpers: decide when a goal is simple enough to
 * skip coordinator decomposition, and pick the best-matching agent for it.
 *
 * Exported for unit testing and re-exported from the orchestrator barrel so the
 * public `isSimpleGoal` / `selectBestAgent` import paths stay stable.
 */

import type { AgentConfig } from '../types.js'
import { AgentSelector } from './agent-selector.js'

/**
 * Unicode ranges treated as CJK for both the length estimate and the dense
 * enumeration signal: CJK Unified Ideographs + Extension A + Compatibility
 * Ideographs (Chinese), Japanese kana, and Korean Hangul syllables. Defined
 * once so length weighting and enumeration detection cover the same scripts.
 */
const CJK_RANGES = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'

/**
 * Regex patterns that indicate a goal requires multi-agent coordination.
 *
 * Each pattern targets a distinct complexity signal:
 * - Sequencing:     "first … then", "先…然后", "まず…次に", "먼저…그다음",
 *                   numbered/ordinal and circled lists
 * - Coordination:   "collaborate", "coordinate", "review each other"
 * - Parallel work:  "in parallel", "at the same time", "concurrently"
 * - Multi-phase:    multilingual enumeration and action verbs joined by connectives
 *
 * Non-goal — CJK verb-connective sequencing: Chinese keeps a verb-connective
 * pattern (构建…并…测试) because its verbs are invariant tokens. Japanese and
 * Korean verbs inflect (Japanese て-form 書いて/作成し, Korean agglutinative
 * endings 만들고/작성한), so a fixed verb list would miss most conjugations and
 * matching them reliably would require morphological analysis. The honest,
 * cheap-heuristic positioning deliberately rejects that. Japanese/Korean
 * sequencing is instead covered by explicit ordinal/step markers and by CJK
 * enumeration punctuation, never by a verb lexicon.
 */
export const COMPLEXITY_PATTERNS: RegExp[] = [
  // Explicit sequencing
  /\bfirst\b.{3,60}\bthen\b/i,
  /\bstep\s*\d/i,
  /\bphase\s*\d/i,
  /\bstage\s*\d/i,
  /^\s*\d+[\.\)]/m,                       // numbered list items ("1. …", "2) …")
  /(?:首先|先).{1,60}(?:然后|接着|再)(?:.{1,60}(?:最后))?/,
  /第[一二三四五六七八九十\d]+步.{1,80}第[一二三四五六七八九十\d]+步/,
  // Japanese sequencing — both markers of a pair must appear, so a lone まず or
  // 次に stays simple (mirrors the Chinese 先…然后 shape). The trailing 最後に in
  // まず…次に…最後に is optional and does not change the match.
  /(?:まず|最初に).{1,80}(?:次に|それから|続いて)(?:.{1,80}最後に)?/,
  /第[一二三四五六七八九十\d]+に.{1,80}第[一二三四五六七八九十\d]+に/,
  /(?:ステップ|手順)\s*\d.{1,80}(?:ステップ|手順)\s*\d/,
  // Korean sequencing — pair required, same shape. Particle-attached hangul
  // (agglutinative) keeps the markers intact, so explicit markers still fire.
  /먼저.{1,80}(?:그\s*다음|그리고\s*나서)(?:.{1,80}마지막으로)?/,
  /(?:첫째|첫\s*번째).{1,80}(?:둘째|두\s*번째)/,
  /\d\s*단계.{1,80}\d\s*단계/,
  /[①②③④⑤⑥⑦⑧⑨⑩].{1,100}[②③④⑤⑥⑦⑧⑨⑩]/,

  // Coordination language — must be an imperative directive aimed at the agents
  // ("collaborate with X", "coordinate the team", "agents should coordinate"),
  // not a descriptive use ("how does X coordinate with Y" / "what does collaboration mean").
  // Match either an explicit preposition or a noun-phrase that names a group.
  /\bcollaborat(?:e|ing)\b\s+(?:with|on|to)\b/i,
  /\bcoordinat(?:e|ing)\b\s+(?:with|on|across|between|the\s+(?:team|agents?|workers?|effort|work))\b/i,
  /\breview\s+each\s+other/i,
  /\bwork\s+together\b/i,

  // Parallel execution
  /\bin\s+parallel\b/i,
  /\bconcurrently\b/i,
  /\bat\s+the\s+same\s+time\b/i,

  // Enumerations and multiple deliverables joined by connectives
  // Dense CJK enumeration (5+ 、-separated items). Reuses the shared CJK ranges
  // so kana- and Hangul-initial lists count the same as Han-initial ones. The 、
  // separator is intentional — Latin/English comma lists keep prior behavior.
  new RegExp(`(?:[${CJK_RANGES}][^、\\n]{0,39}、){5}`),
  /[^；\n]{2,80}；[^；\n]{2,80}/,            // Chinese semicolon-separated clauses
  // Matches patterns like "build X, then deploy Y and test Z"
  /\b(?:build|create|implement|design|write|develop)\b[^.!?\n]{5,80}\b(?:and|then)\b[^.!?\n]{5,80}\b(?:build|create|implement|design|write|develop|test|review|deploy)\b/i,
  /(?:构建|创建|实现|设计|编写|开发|分析|收集|部署|测试|审查|审核|研究|撰写).{0,40}、.{0,40}(?:构建|创建|实现|设计|编写|开发|生成|部署|测试|审查|审核|研究|撰写)/,
  /(?:构建|创建|实现|设计|编写|开发|分析|收集|部署|测试|审查|审核|研究|撰写).{1,50}(?:并|然后|再|接着).{0,50}(?:构建|创建|实现|设计|编写|开发|生成|部署|测试|审查|审核|研究|撰写)/,
]

/**
 * Maximum estimated information-unit length below which a goal *may* be simple.
 *
 * Kept at the existing public value for compatibility. Latin word runs are
 * capped at roughly one token (four character units), while CJK characters
 * count as 2.25 units because they carry more information per source
 * character. Very long unbroken runs retain their raw length so pathological
 * or generated payloads do not bypass the limit.
 */
export const SIMPLE_GOAL_MAX_LENGTH = 200

const CJK_CHARACTER = new RegExp(`[${CJK_RANGES}]`)
const LATIN_ALPHANUMERIC = /[A-Za-z0-9]/
const NORMAL_LATIN_RUN_UNITS = 4
const LONG_UNBROKEN_RUN = 32
const CJK_INFORMATION_UNITS = 2.25

/** Estimate comparable information density without depending on one language's script. */
export function estimateGoalInformationUnits(goal: string): number {
  let units = 0
  let latinRun = 0
  const flushLatinRun = (): void => {
    if (latinRun === 0) return
    units += latinRun > LONG_UNBROKEN_RUN
      ? latinRun
      : Math.min(latinRun, NORMAL_LATIN_RUN_UNITS)
    latinRun = 0
  }

  for (const character of goal) {
    if (LATIN_ALPHANUMERIC.test(character)) {
      latinRun++
      continue
    }
    flushLatinRun()
    if (CJK_CHARACTER.test(character)) {
      units += CJK_INFORMATION_UNITS
    } else if (!/\s/.test(character)) {
      units++
    }
  }
  flushLatinRun()
  return Math.ceil(units)
}

/**
 * Determine whether a goal is simple enough to skip coordinator decomposition.
 *
 * A goal is considered "simple" when ALL of the following hold:
 *   1. Its estimated information length is ≤ {@link SIMPLE_GOAL_MAX_LENGTH}.
 *   2. It does not match any {@link COMPLEXITY_PATTERNS}.
 *
 * The complexity patterns are deliberately conservative — they only fire on
 * imperative coordination directives (e.g. "collaborate with the team",
 * "coordinate the workers"), so descriptive uses ("how do pods coordinate
 * state", "explain microservice collaboration") remain classified as simple.
 *
 * Exported for unit testing.
 */
export function isSimpleGoal(goal: string): boolean {
  if (estimateGoalInformationUnits(goal) > SIMPLE_GOAL_MAX_LENGTH) return false
  return !COMPLEXITY_PATTERNS.some((re) => re.test(goal))
}

/**
 * Select the best-matching agent for a goal through {@link AgentSelector}.
 *
 * With no declared capabilities, the soft-scoring logic mirrors
 * {@link Scheduler}'s `capability-match` strategy, including its asymmetric
 * use of the agent's `model` field:
 *
 *  - `agentKeywords` is computed from `name + systemPrompt + model` so that
 *    a goal which mentions a model name (e.g. "haiku") can boost an agent
 *    bound to that model.
 *  - `agentText` (used for the reverse direction) is computed from
 *    `name + systemPrompt` only — model names should not bias the
 *    text-vs-goal-keywords match.
 *
 * The two-direction sum (`scoreA + scoreB`) ensures both "agent describes
 * goal" and "goal mentions agent capability" contribute to the final score.
 *
 * Declared capability affinity is a higher-priority soft signal. Score ties,
 * including an all-zero result, are resolved by ascending agent
 * name; duplicate names preserve roster order. Unlike Scheduler's stateful
 * `capability-match` zero-score fallback, this helper cannot round-robin across
 * calls because each invocation is stateless.
 *
 * Exported for unit testing.
 */
export function selectBestAgent(goal: string, agents: AgentConfig[]): AgentConfig {
  if (agents.length <= 1) return agents[0]!
  return new AgentSelector().select(goal, agents).agent!
}
