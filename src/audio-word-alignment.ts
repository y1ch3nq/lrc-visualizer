import { splitLyricGraphemes, type LyricLine, type LyricWord } from './lrc.ts'

export interface WordAlignmentResult {
  lines: LyricLine[]
  alignedLineCount: number
  detectedOnsetCount: number
  confidence: number
}

interface AcousticOnset {
  time: number
  strength: number
}

interface AcousticAnalysis {
  onsets: AcousticOnset[]
  duration: number
}

type WindowWithAudioFallback = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext
}

const analysisSampleRate = 100

/**
 * Pure front-end lyric alignment. This deliberately does not pretend to be
 * speech recognition: it maps known lyric words to likely vocal/acoustic
 * onsets inside each line's start/end window. Explicit line ends therefore
 * materially improve the result, especially before long instrumental gaps.
 */
export async function alignLyricsToAudio(
  file: File,
  lines: LyricLine[],
  fallbackDuration: number,
): Promise<WordAlignmentResult> {
  if (lines.length === 0) {
    return { lines, alignedLineCount: 0, detectedOnsetCount: 0, confidence: 0 }
  }

  const analysis = await analyzeAcousticOnsets(file)
  let alignedLineCount = 0
  let confidenceSum = 0
  let confidenceSamples = 0

  const alignedLines = lines.map((line, index) => {
    const tokens = tokenizeLyricWords(line.text)
    if (tokens.length === 0) {
      return { ...line, words: [] }
    }

    const nextStart = lines[index + 1]?.time
    const requestedEnd = line.endTime && line.endTime > line.time
      ? line.endTime
      : nextStart ?? Math.max(fallbackDuration, analysis.duration, line.time + 1.5)
    const endTime = Math.max(line.time + 0.12, requestedEnd)
    const candidates = analysis.onsets.filter((onset) => (
      onset.time >= line.time + 0.035 && onset.time <= endTime - 0.025
    ))
    const { words, confidence } = alignTokensWithinWindow(tokens, line.time, endTime, candidates)

    alignedLineCount += 1
    confidenceSum += confidence
    confidenceSamples += 1

    return {
      ...line,
      words,
    }
  })

  return {
    lines: alignedLines,
    alignedLineCount,
    detectedOnsetCount: analysis.onsets.length,
    confidence: confidenceSamples > 0 ? confidenceSum / confidenceSamples : 0,
  }
}

export function tokenizeLyricWords(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }

  const spaced = trimmed.match(/\S+/gu) ?? []
  if (spaced.length > 1 || !/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(trimmed)) {
    return spaced
  }

  const tokens: string[] = []
  for (const grapheme of splitLyricGraphemes(trimmed)) {
    if (/^[，。！？、；：,.!?;:）)】\]}]$/u.test(grapheme) && tokens.length > 0) {
      tokens[tokens.length - 1] += grapheme
    } else if (grapheme.trim()) {
      tokens.push(grapheme)
    }
  }
  return tokens
}

async function analyzeAcousticOnsets(file: File): Promise<AcousticAnalysis> {
  const AudioContextConstructor = window.AudioContext || (window as WindowWithAudioFallback).webkitAudioContext
  if (!AudioContextConstructor) {
    throw new Error('当前浏览器不支持纯前端音频分析')
  }

  const context = new AudioContextConstructor()
  try {
    const encoded = await file.arrayBuffer()
    const buffer = await context.decodeAudioData(encoded.slice(0))
    return buildAcousticAnalysis(buffer)
  } finally {
    await context.close().catch(() => undefined)
  }
}

function buildAcousticAnalysis(buffer: AudioBuffer): AcousticAnalysis {
  const bucketSize = Math.max(1, Math.floor(buffer.sampleRate / analysisSampleRate))
  const bucketCount = Math.max(1, Math.ceil(buffer.length / bucketSize))
  const rawEnergy = new Float32Array(bucketCount)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
  const upperPassAmount = 1 - Math.exp((-2 * Math.PI * 4_200) / buffer.sampleRate)
  const lowerPassAmount = 1 - Math.exp((-2 * Math.PI * 140) / buffer.sampleRate)
  let upperPassed = 0
  let lowerPassed = 0
  let energy = 0
  let sampleCount = 0
  let bucketIndex = 0

  for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
    let mono = 0
    for (const channel of channels) {
      mono += channel[sampleIndex] ?? 0
    }
    mono /= Math.max(1, channels.length)

    upperPassed += (mono - upperPassed) * upperPassAmount
    lowerPassed += (mono - lowerPassed) * lowerPassAmount
    const vocalBand = upperPassed - lowerPassed
    energy += vocalBand * vocalBand
    sampleCount += 1

    if (sampleCount >= bucketSize || sampleIndex === buffer.length - 1) {
      rawEnergy[bucketIndex] = Math.log1p(Math.sqrt(energy / Math.max(1, sampleCount)) * 42)
      bucketIndex += 1
      energy = 0
      sampleCount = 0
    }
  }

  const onsetEnvelope = new Float32Array(rawEnergy.length)
  let baseline = rawEnergy[0] ?? 0
  let previous = baseline
  for (let index = 0; index < rawEnergy.length; index += 1) {
    const value = rawEnergy[index]
    baseline += (value - baseline) * 0.035
    const positiveFlux = Math.max(0, value - previous)
    const localLift = Math.max(0, value - baseline)
    onsetEnvelope[index] = positiveFlux * 1.9 + localLift * 0.72
    previous = value
  }

  const sorted = Array.from(onsetEnvelope).sort((left, right) => left - right)
  const floor = percentile(sorted, 0.28)
  const strong = Math.max(floor + 1e-5, percentile(sorted, 0.96))
  const normalized = new Float32Array(onsetEnvelope.length)
  for (let index = 0; index < onsetEnvelope.length; index += 1) {
    normalized[index] = clamp((onsetEnvelope[index] - floor) / (strong - floor))
  }

  const onsets: AcousticOnset[] = []
  const minimumDistance = Math.round(analysisSampleRate * 0.075)
  for (let index = 2; index < normalized.length - 2; index += 1) {
    const strength = normalized[index]
    if (strength < 0.13) {
      continue
    }
    if (strength < normalized[index - 1] || strength < normalized[index + 1]
      || strength < normalized[index - 2] || strength < normalized[index + 2]) {
      continue
    }

    const previousOnset = onsets[onsets.length - 1]
    if (previousOnset && index / analysisSampleRate - previousOnset.time < minimumDistance / analysisSampleRate) {
      if (strength > previousOnset.strength) {
        previousOnset.time = index / analysisSampleRate
        previousOnset.strength = strength
      }
      continue
    }
    onsets.push({ time: index / analysisSampleRate, strength })
  }

  return { onsets, duration: buffer.duration }
}

function alignTokensWithinWindow(
  tokens: string[],
  startTime: number,
  endTime: number,
  candidates: AcousticOnset[],
): { words: LyricWord[]; confidence: number } {
  if (tokens.length === 1) {
    return { words: [{ text: tokens[0], time: startTime }], confidence: 1 }
  }

  const weights = tokens.map((token) => Math.max(1, Math.sqrt(splitLyricGraphemes(token).length)))
  const totalWeight = Math.max(1, weights.reduce((sum, weight) => sum + weight, 0))
  const usableDuration = Math.max(0.08, (endTime - startTime) * 0.9)
  const words: LyricWord[] = [{ text: tokens[0], time: startTime }]
  const usedCandidates = new Set<number>()
  let accumulatedWeight = weights[0] ?? 1
  let previousTime = startTime
  let confidence = 0
  const minimumGap = Math.min(
    0.045,
    Math.max(0.006, (endTime - startTime - 0.02) / Math.max(2, tokens.length + 1)),
  )

  for (let index = 1; index < tokens.length; index += 1) {
    const idealTime = startTime + usableDuration * accumulatedWeight / totalWeight
    const averageSpacing = (endTime - startTime) / Math.max(1, tokens.length)
    const searchWindow = Math.max(0.18, averageSpacing * 0.9)
    let bestCandidateIndex = -1
    let bestScore = Number.POSITIVE_INFINITY

    candidates.forEach((candidate, candidateIndex) => {
      if (usedCandidates.has(candidateIndex) || candidate.time <= previousTime + minimumGap) {
        return
      }
      const distance = Math.abs(candidate.time - idealTime)
      if (distance > searchWindow) {
        return
      }
      const score = distance / searchWindow - candidate.strength * 0.42
      if (score < bestScore) {
        bestScore = score
        bestCandidateIndex = candidateIndex
      }
    })

    const selected = bestCandidateIndex >= 0 ? candidates[bestCandidateIndex] : undefined
    const minimumTime = previousTime + minimumGap
    const remainingTokens = tokens.length - index - 1
    const latestTime = Math.max(
      minimumTime,
      endTime - 0.015 - remainingTokens * minimumGap,
    )
    const wordTime = clampNumber(selected?.time ?? idealTime, minimumTime, latestTime)
    if (selected) {
      usedCandidates.add(bestCandidateIndex)
      confidence += selected.strength
    }
    words.push({ text: tokens[index], time: wordTime })
    previousTime = wordTime
    accumulatedWeight += weights[index] ?? 1
  }

  return {
    words,
    confidence: clamp(confidence / Math.max(1, tokens.length - 1)),
  }
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * ratio)))
  return sortedValues[index]
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}
