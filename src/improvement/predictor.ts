/** The predictor protocol: pluggable cheap scorers that rank candidate harnesses before expensive probes run —
 *  the "world model" of RSI-Anything (arXiv 2610.13912), adapted to prompt-harness search. */
import type { Tree } from './tree.ts'

/** What one prediction receives: the incumbent tree, a candidate, and the notes its editor attached. */
export interface PredictInput { base: Tree; candidate: Tree; notes?: string }
/** One prediction: a 0-100 quality score, 0-1 uncertainty, the uncertainty-penalized ranking value, and the named signals. */
export interface Prediction { score: number; uncertainty: number; penalized: number; reasons: string[] }
/** A pluggable predictor. Registered by name; the CLI's --predictor picks one. */
export interface Predictor { name: string; description: string; predict(input: PredictInput): Prediction }

const registry = new Map<string, Predictor>()
/** Registers a predictor; a name claimed twice is refused, so --predictor stays unambiguous. */
export function registerPredictor(candidate: Predictor): void {
  if (registry.has(candidate.name)) throw new Error(`predictor name already registered: ${candidate.name}`)
  registry.set(candidate.name, candidate)
}
/** The registered predictors in registration order. */
export const predictors = (): Predictor[] => [...registry.values()]
/** The one predictor a name names, if any. */
export const predictor = (name: string): Predictor | undefined => registry.get(name)
/** The registry default, when no --predictor is given. */
export const defaultPredictorName = 'heuristic'
/** Ranks by the uncertainty-penalized value: score − λ·uncertainty·100 (RSI-Anything's rationing rule). */
export const penalized = (score: number, uncertainty: number, lambda: number): number => score - lambda * uncertainty * 100

const treeText = (tree: Tree, group: 'team' | 'skills' | 'overrides'): string =>
  tree.filter(file => file.path.startsWith(`${group}/`)).map(file => file.text).join('\n')
const treeChars = (tree: Tree, group: 'team' | 'skills' | 'overrides'): number => treeText(tree, group).length

/** The built-in cheap predictor: static signals only — growth budget, skill usage, evidence naming, restatement. */
registerPredictor({
  name: 'heuristic',
  description: 'static signals: always-on growth (penalized), new skills (rewarded), rollout moments named in notes (rewarded), restatement of base lines (penalized)',
  predict({ base, candidate, notes }) {
    const reasons: string[] = []
    let score = 50
    const baseLines = new Set(treeText(base, 'team').split('\n').map(line => line.trim()).filter(Boolean))
    // Growth budget: always-on text rides in every model request; growth beyond +15% is measured to hurt.
    const before = treeChars(base, 'team') + treeChars(base, 'overrides')
    const after = treeChars(candidate, 'team') + treeChars(candidate, 'overrides')
    const growth = after - before
    const growthRatio = before > 0 ? growth / before : 0
    if (growth > 0) {
      const penalty = Math.min(30, Math.round(growth / 40))
      score -= penalty
      reasons.push(`always-on growth +${growth} chars (+${Math.round(growthRatio * 100)}%) → −${penalty}`)
    } else if (growth < 0) {
      score += Math.min(10, Math.round(-growth / 60))
      reasons.push(`always-on compressed ${-growth} chars → +${Math.min(10, Math.round(-growth / 60))}`)
    }
    // Skills are free until read: a candidate that moved knowledge into skills earns its seat.
    const skillsAdded = candidate.filter(file => file.path.startsWith('skills/') && !base.some(baseFile => baseFile.path === file.path)).length
    const skillBonus = Math.min(18, skillsAdded * 9)
    if (skillsAdded) { score += skillBonus; reasons.push(`${skillsAdded} new skill(s) → +${skillBonus}`) }
    // Evidence moments: the notes must name the rollouts behind each edit.
    const moments = (notes?.match(/rollouts\//g) ?? []).length
    const momentBonus = Math.min(12, moments * 4)
    if (moments) { score += momentBonus; reasons.push(`${moments} rollout moments named → +${momentBonus}`) }
    const singles = (notes?.match(/CONFIRMED: SINGLE/g) ?? []).length
    if (singles) { score -= singles * 8; reasons.push(`${singles} single-source edit(s) → −${singles * 8}`) }
    if (!notes?.trim()) { score -= 15; reasons.push('no notes → −15') }
    // Restatement: growth with NO genuinely new lines means every added char was copied from base text.
    const candidateLines = treeText(candidate, 'team').split('\n').map(line => line.trim()).filter(Boolean)
    const addedLines = candidateLines.filter(line => !baseLines.has(line))
    if (growth > 0 && addedLines.every(line => baseLines.has(line))) {
      score -= 20
      reasons.push('added text restates base lines → −20')
    }
    const bounded = Math.max(0, Math.min(100, score))
    const uncertainty = Math.max(0, Math.min(1, 0.1 + (singles ? 0.25 * Math.min(singles, 2) : 0) + (notes?.trim() ? 0 : 0.4)))
    return { score: Math.round(bounded), uncertainty: Math.round(uncertainty * 100) / 100, penalized: Math.round(bounded - uncertainty * 100), reasons }
  },
})
