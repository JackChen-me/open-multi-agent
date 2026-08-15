import { describe, it, expect } from 'vitest'
import { STOP_WORDS, extractKeywords, keywordScore } from '../src/utils/keywords.js'

// Regression coverage for the shared keyword helpers extracted from
// orchestrator.ts and scheduler.ts (PR #70 review point 1).
//
// These tests pin behaviour so future drift between Scheduler and the
// short-circuit selector is impossible — any edit must update the shared
// module and these tests at once.

describe('utils/keywords', () => {
  describe('STOP_WORDS', () => {
    it('contains all 26 stop words', () => {
      // Sanity-check the canonical list — if anyone adds/removes a stop word
      // they should also update this assertion.
      expect(STOP_WORDS.size).toBe(26)
    })

    it('includes "then" and "and" so they cannot dominate scoring', () => {
      expect(STOP_WORDS.has('then')).toBe(true)
      expect(STOP_WORDS.has('and')).toBe(true)
    })
  })

  describe('extractKeywords', () => {
    it('lowercases and dedupes', () => {
      const out = extractKeywords('TypeScript typescript TYPESCRIPT')
      expect(out).toEqual(['typescript'])
    })

    it('drops words shorter than 4 characters', () => {
      const out = extractKeywords('a bb ccc dddd eeeee')
      expect(out).toEqual(['dddd', 'eeeee'])
    })

    it('drops stop words', () => {
      const out = extractKeywords('the cat and the dog have meals')
      // 'cat', 'dog', 'have' filtered: 'cat'/'dog' too short, 'have' is a stop word
      expect(out).toEqual(['meals'])
    })

    it('splits on non-word characters', () => {
      const out = extractKeywords('hello,world!writer-mode')
      expect(out.sort()).toEqual(['hello', 'mode', 'world', 'writer'])
    })

    it('returns empty array for empty input', () => {
      expect(extractKeywords('')).toEqual([])
    })

    it('extracts CJK words with at least two characters', () => {
      expect(extractKeywords('分析代码质量并生成评审报告')).toEqual([
        '分析',
        '代码',
        '质量',
        '生成',
        '评审',
        '报告',
      ])
    })

    it('extracts keywords from mixed Chinese and English text', () => {
      expect(extractKeywords('Review这段TypeScript代码并生成API报告')).toEqual([
        'review',
        'typescript',
        '代码',
        '生成',
        '报告',
      ])
    })

    it('segments Japanese words without spaces', () => {
      expect(extractKeywords('コード品質を分析してレビューレポートを作成する')).toEqual([
        'コード',
        '品質',
        '分析',
        'レビュー',
        'レポート',
        '作成',
        'する',
      ])
    })

    it('segments Korean with particles attached to stems (agglutinative)', () => {
      // Intl.Segmenter keeps object/verb particles attached (품질을, 분석하고,
      // 보고서를). Substring keywordScore still matches these against bare stems
      // in the other direction, which is why agent selection stays robust
      // without any stemming. This test pins that surface behaviour.
      expect(extractKeywords('코드 품질을 분석하고 리뷰 보고서를 작성한다')).toEqual([
        '코드',
        '품질을',
        '분석하고',
        '리뷰',
        '보고서를',
        '작성한다',
      ])
    })

    it('preserves pure-English punctuation and length behaviour', () => {
      expect(extractKeywords("Writer's notes don't include tiny API words")).toEqual([
        'writer',
        'notes',
        'include',
        'tiny',
        'words',
      ])
    })
  })

  describe('keywordScore', () => {
    it('counts each keyword at most once', () => {
      // 'code' appears twice in the text but contributes 1
      expect(keywordScore('code review code style', ['code'])).toBe(1)
    })

    it('is case-insensitive', () => {
      expect(keywordScore('TYPESCRIPT', ['typescript'])).toBe(1)
      expect(keywordScore('typescript', ['TYPESCRIPT'])).toBe(1)
    })

    it('returns 0 when no keywords match', () => {
      expect(keywordScore('hello world', ['rust', 'go'])).toBe(0)
    })

    it('sums distinct keyword hits', () => {
      expect(keywordScore('write typescript code for the api', ['typescript', 'code', 'rust'])).toBe(2)
    })

    it('returns 0 for empty keywords array', () => {
      expect(keywordScore('any text', [])).toBe(0)
    })
  })
})
