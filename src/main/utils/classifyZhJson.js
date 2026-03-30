/** @typedef {{ name: string, score: number, evidence: string[] }} ZhLabelEntry */

export const ZH_LABEL_ORDER = ['海軍', '陸軍', '空軍', '聯合作戰', '演訓戰備', '其他']

const ZH_SET = new Set(ZH_LABEL_ORDER)

/**
 * @param {number} n
 */
function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * @param {number} n
 */
export function roundScore2(n) {
  return Math.round(clamp01(n) * 100) / 100
}

/**
 * @param {unknown} t
 */
export function clampThreshold(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return 0.55
  return Math.min(1, Math.max(0, t))
}

/**
 * @param {string} s
 */
export function stripMarkdownFence(s) {
  let t = String(s).trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '').trim()
  }
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) t = t.slice(i, j + 1)
  return t.trim()
}

/**
 * Parse model JSON → six fixed labels (no final_labels enforcement).
 * @param {string} rawText
 * @returns {{ ok: true, labels: ZhLabelEntry[] } | { ok: false, reason: string }}
 */
export function parseZhClassificationResponse(rawText) {
  let parsed
  try {
    parsed = JSON.parse(stripMarkdownFence(rawText))
  } catch {
    return { ok: false, reason: 'JSON_PARSE_FAILED' }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.labels)) {
    return { ok: false, reason: 'JSON_PARSE_FAILED' }
  }

  /** @type {Map<string, { score?: unknown, evidence?: unknown }>} */
  const byName = new Map()
  for (const entry of parsed.labels) {
    if (entry && typeof entry.name === 'string' && ZH_SET.has(entry.name)) {
      byName.set(entry.name, entry)
    }
  }

  /** @type {ZhLabelEntry[]} */
  const labels = ZH_LABEL_ORDER.map((name) => {
    const e = byName.get(name)
    const score = roundScore2(typeof e?.score === 'number' ? e.score : 0)
    const evidence = Array.isArray(e?.evidence)
      ? e.evidence
          .filter((x) => typeof x === 'string')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 3)
      : []
    return { name, score, evidence }
  })

  return { ok: true, labels }
}

/**
 * 多段／多檔 LM 結果：各標籤分數取平均；evidence 優先採用該標籤分數最高那一段的 evidence，否則合併去重取前三。
 * @param {Array<{ labels: ZhLabelEntry[] }>} okRuns
 * @returns {ZhLabelEntry[]}
 */
export function balanceZhLabelsFromRuns(okRuns) {
  const runs = okRuns.filter((r) => r && Array.isArray(r.labels) && r.labels.length > 0)
  if (runs.length === 0) {
    return ZH_LABEL_ORDER.map((name) => ({ name, score: 0, evidence: [] }))
  }

  return ZH_LABEL_ORDER.map((name) => {
    let sum = 0
    let n = 0
    let bestScore = -1
    /** @type {string[]} */
    let bestEv = []
    /** @type {string[]} */
    const pool = []

    for (const run of runs) {
      const L = run.labels.find((l) => l.name === name)
      if (!L) continue
      sum += L.score
      n += 1
      const ev = Array.isArray(L.evidence) ? L.evidence : []
      for (const x of ev) {
        if (typeof x === 'string' && x.trim() && !pool.includes(x.trim())) pool.push(x.trim())
      }
      if (L.score > bestScore && ev.length > 0) {
        bestScore = L.score
        bestEv = ev.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3)
      }
    }

    const score = roundScore2(n > 0 ? sum / n : 0)
    const evidence = (bestEv.length > 0 ? bestEv : pool).slice(0, 3)
    return { name, score, evidence }
  })
}

/**
 * @param {ZhLabelEntry[]} labels
 * @param {number} threshold
 * @returns {string[]}
 */
export function computeFinalLabelsFromBalanced(labels, threshold) {
  const th = clampThreshold(threshold)
  /** @type {string[]} */
  const finals = []
  for (const l of labels) {
    if (l.score >= th && l.evidence.length > 0) finals.push(l.name)
  }
  if (finals.length === 0) return ['其他']
  return finals
}

/**
 * Single-shot parse + threshold (e.g. retry dialog).
 * @param {string} rawText
 * @param {number} threshold
 */
export function parseZhClassificationJson(rawText, threshold) {
  const parsed = parseZhClassificationResponse(rawText)
  if (!parsed.ok) return parsed
  const final_labels = computeFinalLabelsFromBalanced(parsed.labels, threshold)
  return { ok: true, labels: parsed.labels, final_labels }
}
