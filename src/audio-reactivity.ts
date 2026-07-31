export interface AudioReactiveEnvelope {
  sampleRate: number
  values: Float32Array
}

type WindowWithAudioFallback = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext
}

const envelopeSampleRate = 120

export async function analyzeAudioFile(file: File): Promise<AudioReactiveEnvelope> {
  const AudioContextConstructor = window.AudioContext || (window as WindowWithAudioFallback).webkitAudioContext
  if (!AudioContextConstructor) {
    throw new Error('当前浏览器不支持音频分析')
  }

  const context = new AudioContextConstructor()
  try {
    const encodedAudio = await file.arrayBuffer()
    const buffer = await context.decodeAudioData(encodedAudio.slice(0))
    return buildAudioReactiveEnvelope(buffer)
  } finally {
    await context.close().catch(() => undefined)
  }
}

/**
 * Extract a compact kick/bass envelope once, so preview and exported frames
 * can sample drum energy without running an FFT or audio graph every frame.
 */
export function buildAudioReactiveEnvelope(buffer: AudioBuffer): AudioReactiveEnvelope {
  const bucketSize = Math.max(1, Math.floor(buffer.sampleRate / envelopeSampleRate))
  const bucketCount = Math.max(1, Math.ceil(buffer.length / bucketSize))
  const rawEnergy = new Float32Array(bucketCount)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
  const lowPassAmount = 1 - Math.exp((-2 * Math.PI * 190) / buffer.sampleRate)
  const subPassAmount = 1 - Math.exp((-2 * Math.PI * 38) / buffer.sampleRate)
  let lowPassed = 0
  let subPassed = 0
  let energySum = 0
  let samplesInBucket = 0
  let bucketIndex = 0

  for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
    let monoSample = 0
    for (const channel of channels) {
      monoSample += channel[sampleIndex] ?? 0
    }
    monoSample /= Math.max(1, channels.length)

    lowPassed += (monoSample - lowPassed) * lowPassAmount
    subPassed += (lowPassed - subPassed) * subPassAmount
    const bassBand = lowPassed - subPassed
    energySum += bassBand * bassBand
    samplesInBucket += 1

    if (samplesInBucket >= bucketSize || sampleIndex === buffer.length - 1) {
      rawEnergy[bucketIndex] = Math.sqrt(energySum / Math.max(1, samplesInBucket))
      bucketIndex += 1
      energySum = 0
      samplesInBucket = 0
    }
  }

  const sortedEnergy = Array.from(rawEnergy).sort((left, right) => left - right)
  const noiseFloor = percentile(sortedEnergy, 0.18)
  const strongBeatLevel = Math.max(noiseFloor + 1e-5, percentile(sortedEnergy, 0.94))
  const normalizedEnergy = new Float32Array(rawEnergy.length)
  const values = new Float32Array(rawEnergy.length)

  for (let index = 0; index < rawEnergy.length; index += 1) {
    normalizedEnergy[index] = clamp((rawEnergy[index] - noiseFloor) / (strongBeatLevel - noiseFloor))
  }

  let slowBaseline = 0
  let smoothedBeat = 0
  for (let index = 0; index < normalizedEnergy.length; index += 1) {
    const energy = normalizedEnergy[index]
    slowBaseline += (energy - slowBaseline) * 0.025
    const onset = Math.max(0, energy - slowBaseline) * 1.85
    const target = clamp(energy * 0.56 + onset * 0.9)
    smoothedBeat += (target - smoothedBeat) * (target > smoothedBeat ? 0.52 : 0.075)
    values[index] = Math.pow(clamp(smoothedBeat), 0.82)
  }

  return { sampleRate: envelopeSampleRate, values }
}

export function sampleAudioReactiveEnvelope(
  envelope: AudioReactiveEnvelope | null | undefined,
  currentTime: number,
): number {
  if (!envelope || envelope.values.length === 0 || currentTime < 0) {
    return 0
  }

  const position = currentTime * envelope.sampleRate
  const startIndex = Math.min(envelope.values.length - 1, Math.max(0, Math.floor(position)))
  const endIndex = Math.min(envelope.values.length - 1, startIndex + 1)
  const fraction = clamp(position - startIndex)
  return envelope.values[startIndex] + (envelope.values[endIndex] - envelope.values[startIndex]) * fraction
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0
  }

  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * ratio)))
  return sortedValues[index]
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}
