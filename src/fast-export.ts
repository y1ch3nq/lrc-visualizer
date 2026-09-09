import { type ParsedLrc } from './lrc.ts'
import {
  drawVisualizer,
  fitCanvasToSettings,
  type VisualizerCanvasContext,
  type VisualizerSettings,
} from './renderer.ts'
import { muxMp4 } from './mp4-muxer.ts'
import {
  buildAudioReactiveEnvelope,
  sampleAudioReactiveEnvelope,
  type AudioReactiveEnvelope,
} from './audio-reactivity.ts'

interface FastExportInput {
  audioUrl: string
  audioFileName: string
  lines: ParsedLrc['lines']
  duration: number
  startTime: number
  endTime: number
  settings: VisualizerSettings
  title?: string
  artist?: string
  coverImage?: CanvasImageSource
  backgroundImage?: CanvasImageSource
  brandIconImage?: CanvasImageSource
  sodaBrandText?: string
  sodaPlaylistText?: string
  audioReactiveEnvelope?: AudioReactiveEnvelope
  onProgress: (progress: number, currentTime: number) => void
}

export interface FastExportSupport {
  supported: boolean
  reason?: string
  format?: 'MP4' | 'WebM'
}

export interface FastExportResult {
  url: string
  filename: string
  mimeType: string
}

interface EncodedTrackChunk {
  trackNumber: number
  timestampUs: number
  durationUs: number
  keyFrame: boolean
  data: Uint8Array
  alphaSideData?: Uint8Array
}

type EncodedVideoChunkMetadataWithAlpha = EncodedVideoChunkMetadata & {
  alphaSideData?: AllowSharedBufferSource
}

interface VideoEncodingPlan {
  config: VideoEncoderConfig
  codecId?: 'V_VP8' | 'V_VP9'
}

interface AudioEncodingPlan {
  config: AudioEncoderConfig
  sampleRate: number
  numberOfChannels: number
  frameSamples: number
  frameDurationUs: number
}

interface ExportEncodingPlan {
  container: 'mp4' | 'webm'
  video: VideoEncodingPlan
  audio: AudioEncodingPlan
}

interface EncodedTrackResult {
  chunks: EncodedTrackChunk[]
  decoderConfig?: Uint8Array
}

interface RenderCanvas {
  canvas: HTMLCanvasElement | OffscreenCanvas
  ctx: VisualizerCanvasContext
}

type WindowWithAudioFallback = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext
}

const fastFrameRate = 60
const videoTrackNumber = 1
const audioTrackNumber = 2
const audioSampleRate = 48_000
const audioChannelCount = 2
const opusFrameDurationUs = 20_000
const aacFrameSamples = 1_024
const clusterMaxDurationMs = 5_000

export async function getDirectExportSupport(settings: VisualizerSettings): Promise<FastExportSupport> {
  if (!('VideoEncoder' in window) || !('AudioEncoder' in window) || !('VideoFrame' in window) || !('AudioData' in window)) {
    return {
      supported: false,
      reason: '当前浏览器不支持 WebCodecs 快速导出',
    }
  }

  if (!('OfflineAudioContext' in window)) {
    return {
      supported: false,
      reason: '当前浏览器不支持离线音频编码',
    }
  }

  const plan = await selectExportPlan(settings)
  if (!plan) {
    return {
      supported: false,
      reason: settings.transparentBackground
        ? '当前浏览器不支持带透明通道的 VP9/Opus 直接导出'
        : '当前浏览器没有可用的 H.264/AAC 或 VP8/VP9/Opus 直接编码组合',
    }
  }

  return { supported: true, format: plan.container === 'mp4' ? 'MP4' : 'WebM' }
}

export async function fastExportVisualizer(input: FastExportInput): Promise<FastExportResult> {
  const support = await getDirectExportSupport(input.settings)

  if (!support.supported) {
    throw new Error(support.reason ?? '快速导出不可用')
  }

  const [plan, sourceAudio] = await Promise.all([
    selectExportPlan(input.settings),
    decodeSourceAudio(input.audioUrl),
  ])

  if (!plan) {
    throw new Error('快速导出编码器初始化失败')
  }

  const sourceDuration = Number.isFinite(sourceAudio.duration) && sourceAudio.duration > 0
    ? sourceAudio.duration
    : input.duration
  const { startTime, endTime, exportDuration } = normalizeExportRange(
    input.startTime,
    input.endTime,
    sourceDuration,
  )
  const audioReactiveEnvelope = input.settings.showBeatBar
    ? input.audioReactiveEnvelope ?? buildAudioReactiveEnvelope(sourceAudio)
    : undefined

  input.onProgress(0.02, startTime)
  const renderedAudio = await renderAudioForExport(
    sourceAudio,
    plan.audio.sampleRate,
    plan.audio.numberOfChannels,
    startTime,
    exportDuration,
  )
  input.onProgress(0.12, startTime)

  const audioTrack = await encodeAudioTrack(renderedAudio, plan.audio, (progress) => {
    input.onProgress(0.12 + progress * 0.12, Math.min(endTime, startTime + progress * exportDuration))
  })

  const renderCanvas = createRenderCanvas(input.settings)
  const videoTrack = await encodeVideoTrack({
    renderCanvas,
    input,
    plan: plan.video,
    duration: exportDuration,
    sourceDuration,
    startTime,
    audioReactiveEnvelope,
    onProgress: (progress, currentTime) => {
      input.onProgress(0.24 + progress * 0.7, currentTime)
    },
  })
  const targetDurationUs = Math.round(exportDuration * 1_000_000)
  const boundedVideoTrack = trimEncodedTrackToDuration(videoTrack, targetDurationUs)
  const boundedAudioTrack = trimEncodedTrackToDuration(audioTrack, targetDurationUs)
  const hasEncodedAlpha = boundedVideoTrack.chunks.some(
    (chunk) => (chunk.alphaSideData?.byteLength ?? 0) > 0,
  )

  if (input.settings.transparentBackground && !hasEncodedAlpha) {
    throw new Error('编码器未返回透明通道数据，请更换支持 VP9 Alpha 的浏览器')
  }

  input.onProgress(0.96, endTime)
  const blob = plan.container === 'mp4'
    ? muxMp4({
        videoSamples: boundedVideoTrack.chunks,
        audioSamples: boundedAudioTrack.chunks,
        width: input.settings.width,
        height: input.settings.height,
        frameRate: fastFrameRate,
        durationUs: Math.round(exportDuration * 1_000_000),
        audioSampleRate: plan.audio.sampleRate,
        audioChannels: plan.audio.numberOfChannels,
        videoDecoderConfig: requireDecoderConfig(boundedVideoTrack.decoderConfig, 'H.264'),
        audioDecoderConfig: boundedAudioTrack.decoderConfig ?? createAacDecoderConfig(
          plan.audio.sampleRate,
          plan.audio.numberOfChannels,
        ),
      })
    : muxWebM({
        videoChunks: boundedVideoTrack.chunks,
        audioChunks: boundedAudioTrack.chunks,
        width: input.settings.width,
        height: input.settings.height,
        durationSeconds: exportDuration,
        frameRate: fastFrameRate,
        videoCodecId: plan.video.codecId ?? 'V_VP9',
        audioSampleRate: plan.audio.sampleRate,
        audioChannels: plan.audio.numberOfChannels,
        hasAlpha: hasEncodedAlpha,
      })

  input.onProgress(1, endTime)

  return {
    url: URL.createObjectURL(blob),
    filename: createExportFilename(
      input.audioFileName,
      startTime,
      endTime,
      sourceDuration,
      plan.container,
    ),
    mimeType: blob.type,
  }
}

async function selectExportPlan(settings: VisualizerSettings): Promise<ExportEncodingPlan | null> {
  if (!settings.transparentBackground) {
    const [video, audio] = await Promise.all([selectMp4VideoPlan(settings), selectAacAudioPlan()])
    if (video && audio) {
      return { container: 'mp4', video, audio }
    }
  }

  const [video, audio] = await Promise.all([selectWebMVideoPlan(settings), selectOpusAudioPlan()])
  return video && audio ? { container: 'webm', video, audio } : null
}

async function selectWebMVideoPlan(settings: VisualizerSettings): Promise<VideoEncodingPlan | null> {
  const candidates: Array<{
    codec: string
    codecId: 'V_VP8' | 'V_VP9'
    alpha: AlphaOption
    hardwareAcceleration: HardwareAcceleration
  }> = settings.transparentBackground
    ? [
        {
          codec: 'vp09.00.10.08',
          codecId: 'V_VP9',
          alpha: 'keep',
          hardwareAcceleration: 'prefer-software',
        },
        {
          codec: 'vp09.00.10.08',
          codecId: 'V_VP9',
          alpha: 'keep',
          hardwareAcceleration: 'no-preference',
        },
      ]
    : [
        {
          codec: 'vp09.00.10.08',
          codecId: 'V_VP9',
          alpha: 'discard',
          hardwareAcceleration: 'prefer-hardware',
        },
        {
          codec: 'vp8',
          codecId: 'V_VP8',
          alpha: 'discard',
          hardwareAcceleration: 'prefer-hardware',
        },
      ]

  for (const candidate of candidates) {
    const config: VideoEncoderConfig = {
      codec: candidate.codec,
      width: settings.width,
      height: settings.height,
      displayWidth: settings.width,
      displayHeight: settings.height,
      framerate: fastFrameRate,
      bitrate: 20_000_000,
      alpha: candidate.alpha,
      hardwareAcceleration: candidate.hardwareAcceleration,
      latencyMode: 'realtime',
    }

    try {
      const support = await VideoEncoder.isConfigSupported(config)
      if (support.supported) {
        return {
          config: {
            ...(support.config ?? config),
            alpha: candidate.alpha,
            hardwareAcceleration: candidate.hardwareAcceleration,
          },
          codecId: candidate.codecId,
        }
      }
    } catch {
      continue
    }
  }

  return null
}

async function selectMp4VideoPlan(settings: VisualizerSettings): Promise<VideoEncodingPlan | null> {
  const candidates = ['avc1.640028', 'avc1.4d4028', 'avc1.42e028']

  for (const codec of candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width: settings.width,
      height: settings.height,
      displayWidth: settings.width,
      displayHeight: settings.height,
      framerate: fastFrameRate,
      bitrate: 20_000_000,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime',
      avc: { format: 'avc' },
    }

    try {
      const support = await VideoEncoder.isConfigSupported(config)
      if (support.supported) {
        return { config: support.config ?? config }
      }
    } catch {
      continue
    }
  }

  return null
}

async function selectOpusAudioPlan(): Promise<AudioEncodingPlan | null> {
  const config: AudioEncoderConfig = {
    codec: 'opus',
    numberOfChannels: audioChannelCount,
    sampleRate: audioSampleRate,
    bitrate: 192_000,
    opus: {
      complexity: 10,
      format: 'opus',
      frameDuration: opusFrameDurationUs,
    },
  }

  try {
    const support = await AudioEncoder.isConfigSupported(config)
    if (!support.supported) {
      return null
    }

    return {
      config: support.config ?? config,
      sampleRate: audioSampleRate,
      numberOfChannels: audioChannelCount,
      frameSamples: Math.round((audioSampleRate * opusFrameDurationUs) / 1_000_000),
      frameDurationUs: opusFrameDurationUs,
    }
  } catch {
    return null
  }
}

async function selectAacAudioPlan(): Promise<AudioEncodingPlan | null> {
  const config: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    numberOfChannels: audioChannelCount,
    sampleRate: audioSampleRate,
    bitrate: 192_000,
  }

  try {
    const support = await AudioEncoder.isConfigSupported(config)
    if (!support.supported) {
      return null
    }

    return {
      config: support.config ?? config,
      sampleRate: audioSampleRate,
      numberOfChannels: audioChannelCount,
      frameSamples: aacFrameSamples,
      frameDurationUs: Math.round((aacFrameSamples * 1_000_000) / audioSampleRate),
    }
  } catch {
    return null
  }
}

async function decodeSourceAudio(audioUrl: string): Promise<AudioBuffer> {
  const response = await fetch(audioUrl)

  if (!response.ok) {
    throw new Error('导出音频读取失败')
  }

  const audioData = await response.arrayBuffer()
  const AudioContextConstructor = window.AudioContext || (window as WindowWithAudioFallback).webkitAudioContext

  if (!AudioContextConstructor) {
    throw new Error('当前浏览器不支持音频解码')
  }

  const audioContext = new AudioContextConstructor()

  try {
    return await audioContext.decodeAudioData(audioData.slice(0))
  } finally {
    await audioContext.close().catch(() => undefined)
  }
}

async function renderAudioForExport(
  sourceAudio: AudioBuffer,
  sampleRate: number,
  numberOfChannels: number,
  startTime: number,
  duration: number,
): Promise<AudioBuffer> {
  const frameCount = Math.max(1, Math.ceil(duration * sampleRate))
  const offlineContext = new OfflineAudioContext(numberOfChannels, frameCount, sampleRate)
  const source = offlineContext.createBufferSource()
  source.buffer = sourceAudio
  source.connect(offlineContext.destination)
  source.start(0, startTime, duration)
  return offlineContext.startRendering()
}

async function encodeAudioTrack(
  buffer: AudioBuffer,
  plan: AudioEncodingPlan,
  onProgress: (progress: number) => void,
): Promise<EncodedTrackResult> {
  const chunks: EncodedTrackChunk[] = []
  let decoderConfig: Uint8Array | undefined
  let encodeError: DOMException | null = null
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      chunks.push(copyEncodedChunk(chunk, audioTrackNumber, true, plan.frameDurationUs))
      decoderConfig ??= copyDecoderConfig(metadata?.decoderConfig?.description)
    },
    error: (error) => {
      encodeError = error
    },
  })

  encoder.configure(plan.config)

  const channels = Array.from({ length: plan.numberOfChannels }, (_, index) => buffer.getChannelData(index))
  const totalFrames = buffer.length
  let lastReportedProgress = -1

  for (let offset = 0; offset < totalFrames; offset += plan.frameSamples) {
    throwIfEncoderFailed(encodeError)

    const availableFrames = Math.min(plan.frameSamples, totalFrames - offset)
    const planarData = new Float32Array(availableFrames * plan.numberOfChannels)

    for (let channelIndex = 0; channelIndex < plan.numberOfChannels; channelIndex += 1) {
      planarData.set(
        channels[channelIndex].subarray(offset, offset + availableFrames),
        channelIndex * availableFrames,
      )
    }

    const audioData = new AudioData({
      data: planarData,
      format: 'f32-planar',
      numberOfChannels: plan.numberOfChannels,
      numberOfFrames: availableFrames,
      sampleRate: plan.sampleRate,
      timestamp: Math.round((offset * 1_000_000) / plan.sampleRate),
    })

    encoder.encode(audioData)
    audioData.close()

    if (encoder.encodeQueueSize > 32) {
      await waitForEncoderQueue(encoder, 8)
      throwIfEncoderFailed(encodeError)
    }

    const progress = offset / Math.max(1, totalFrames)
    if (progress - lastReportedProgress > 0.02) {
      lastReportedProgress = progress
      onProgress(progress)
    }
  }

  await encoder.flush()
  throwIfEncoderFailed(encodeError)
  encoder.close()
  onProgress(1)

  return { chunks, decoderConfig }
}

async function encodeVideoTrack(input: {
  renderCanvas: RenderCanvas
  input: FastExportInput
  plan: VideoEncodingPlan
  duration: number
  sourceDuration: number
  startTime: number
  audioReactiveEnvelope?: AudioReactiveEnvelope
  onProgress: (progress: number, currentTime: number) => void
}): Promise<EncodedTrackResult> {
  const chunks: EncodedTrackChunk[] = []
  let decoderConfig: Uint8Array | undefined
  const nominalFrameDurationUs = Math.round(1_000_000 / fastFrameRate)
  const totalFrames = Math.max(1, Math.ceil(input.duration * fastFrameRate))
  const exportDurationUs = Math.max(1, Math.round(input.duration * 1_000_000))
  const frameDurations = new Map<number, number>()
  let encodeError: DOMException | null = null
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const fallbackDurationUs = frameDurations.get(chunk.timestamp) ?? nominalFrameDurationUs
      frameDurations.delete(chunk.timestamp)
      const encodedChunk = copyEncodedChunk(
        chunk,
        videoTrackNumber,
        chunk.type === 'key',
        fallbackDurationUs,
      )
      const alphaSideData = copyBufferSource(
        (metadata as EncodedVideoChunkMetadataWithAlpha | undefined)?.alphaSideData,
      )

      if (alphaSideData && alphaSideData.byteLength > 0) {
        encodedChunk.alphaSideData = alphaSideData
      }

      chunks.push(encodedChunk)
      decoderConfig ??= copyDecoderConfig(metadata?.decoderConfig?.description)
    },
    error: (error) => {
      encodeError = error
    },
  })

  encoder.configure(input.plan.config)

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    throwIfEncoderFailed(encodeError)

    const timestampUs = Math.round((frameIndex * 1_000_000) / fastFrameRate)
    const nextTimestampUs = frameIndex === totalFrames - 1
      ? exportDurationUs
      : Math.round(((frameIndex + 1) * 1_000_000) / fastFrameRate)
    const frameDurationUs = Math.max(1, nextTimestampUs - timestampUs)
    const currentTime = Math.min(
      input.startTime + input.duration,
      input.startTime + timestampUs / 1_000_000,
    )

    drawVisualizer({
      ctx: input.renderCanvas.ctx,
      lines: input.input.lines,
      currentTime,
      duration: input.sourceDuration,
      settings: input.input.settings,
      title: input.input.title,
      artist: input.input.artist,
      coverImage: input.input.coverImage,
      backgroundImage: input.input.backgroundImage,
      brandIconImage: input.input.brandIconImage,
      sodaBrandText: input.input.sodaBrandText,
      sodaPlaylistText: input.input.sodaPlaylistText,
      beatStrength: sampleAudioReactiveEnvelope(input.audioReactiveEnvelope, currentTime),
    })

    const frame = new VideoFrame(input.renderCanvas.canvas, {
      timestamp: timestampUs,
      duration: frameDurationUs,
      alpha: input.plan.config.alpha === 'keep' ? 'keep' : 'discard',
    })

    frameDurations.set(timestampUs, frameDurationUs)
    encoder.encode(frame, {
      keyFrame: frameIndex % (fastFrameRate * 2) === 0,
    })
    frame.close()

    if (encoder.encodeQueueSize > 12) {
      await waitForEncoderQueue(encoder, 4)
      throwIfEncoderFailed(encodeError)
    }

    if (frameIndex % 6 === 0 || frameIndex === totalFrames - 1) {
      input.onProgress(frameIndex / Math.max(1, totalFrames - 1), currentTime)
    }
  }

  await encoder.flush()
  throwIfEncoderFailed(encodeError)
  encoder.close()

  return { chunks, decoderConfig }
}

function createRenderCanvas(settings: VisualizerSettings): RenderCanvas {
  const canvas = document.createElement('canvas')

  fitCanvasToSettings(canvas, settings)

  const ctx = canvas.getContext('2d', {
    alpha: true,
  }) as VisualizerCanvasContext | null

  if (!ctx) {
    throw new Error('无法创建离屏导出画布')
  }

  return {
    canvas,
    ctx,
  }
}

function copyEncodedChunk(
  chunk: EncodedAudioChunk | EncodedVideoChunk,
  trackNumber: number,
  keyFrame: boolean,
  fallbackDurationUs: number,
): EncodedTrackChunk {
  const data = new Uint8Array(chunk.byteLength)
  chunk.copyTo(data)

  return {
    trackNumber,
    timestampUs: chunk.timestamp,
    durationUs: chunk.duration ?? fallbackDurationUs,
    keyFrame,
    data,
  }
}

function trimEncodedTrackToDuration(
  track: EncodedTrackResult,
  targetDurationUs: number,
): EncodedTrackResult {
  const chunks: EncodedTrackChunk[] = []

  for (const chunk of track.chunks) {
    if (chunk.timestampUs >= targetDurationUs) {
      break
    }

    const remainingDurationUs = targetDurationUs - chunk.timestampUs
    chunks.push({
      ...chunk,
      durationUs: Math.max(1, Math.min(chunk.durationUs, remainingDurationUs)),
    })
  }

  if (chunks.length === 0) {
    throw new Error('编码器没有生成可用的媒体帧')
  }

  return { ...track, chunks }
}

function copyDecoderConfig(description: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  return copyBufferSource(description)
}

function copyBufferSource(source: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!source) {
    return undefined
  }

  if (ArrayBuffer.isView(source)) {
    const copy = new Uint8Array(source.byteLength)
    copy.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength))
    return copy
  }

  const copy = new Uint8Array(source.byteLength)
  copy.set(new Uint8Array(source))
  return copy
}

function requireDecoderConfig(config: Uint8Array | undefined, codec: string): Uint8Array {
  if (!config || config.byteLength === 0) {
    throw new Error(`${codec} 编码器没有返回 MP4 解码配置`)
  }

  return config
}

function createAacDecoderConfig(sampleRate: number, numberOfChannels: number): Uint8Array {
  const sampleRates = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350]
  const frequencyIndex = sampleRates.indexOf(sampleRate)

  if (frequencyIndex < 0) {
    throw new Error('AAC 编码器返回了不支持的采样率')
  }

  const audioObjectType = 2
  return new Uint8Array([
    (audioObjectType << 3) | (frequencyIndex >> 1),
    ((frequencyIndex & 1) << 7) | (numberOfChannels << 3),
  ])
}

function throwIfEncoderFailed(error: DOMException | null): void {
  if (error) {
    throw new Error(error.message || '编码过程中断')
  }
}

async function waitForEncoderQueue(
  encoder: AudioEncoder | VideoEncoder,
  maximumQueueSize: number,
): Promise<void> {
  while (encoder.encodeQueueSize > maximumQueueSize) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }
}

function muxWebM(input: {
  videoChunks: EncodedTrackChunk[]
  audioChunks: EncodedTrackChunk[]
  width: number
  height: number
  durationSeconds: number
  frameRate: number
  videoCodecId: 'V_VP8' | 'V_VP9'
  audioSampleRate: number
  audioChannels: number
  hasAlpha: boolean
}): Blob {
  const ebmlHeader = masterElement(0x1a45dfa3, [
    uintElement(0x4286, 1),
    uintElement(0x42f7, 1),
    uintElement(0x42f2, 4),
    uintElement(0x42f3, 8),
    stringElement(0x4282, 'webm'),
    uintElement(0x4287, 4),
    uintElement(0x4285, 2),
  ])

  const segment = masterElement(0x18538067, [
    masterElement(0x1549a966, [
      uintElement(0x2ad7b1, 1_000_000),
      floatElement(0x4489, input.durationSeconds * 1000),
      stringElement(0x4d80, 'lrc-visualizer'),
      stringElement(0x5741, 'lrc-visualizer-webcodecs'),
    ]),
    masterElement(0x1654ae6b, [
      createVideoTrackEntry(input),
      createAudioTrackEntry(input.audioSampleRate, input.audioChannels),
    ]),
    ...createClusters([...input.videoChunks, ...input.audioChunks]),
  ])

  return new Blob([toBlobPart(ebmlHeader), toBlobPart(segment)], { type: 'video/webm' })
}

function createVideoTrackEntry(input: {
  width: number
  height: number
  frameRate: number
  videoCodecId: 'V_VP8' | 'V_VP9'
  hasAlpha: boolean
}): Uint8Array {
  const videoElements = [
    uintElement(0xb0, input.width),
    uintElement(0xba, input.height),
  ]
  const trackElements = [
    uintElement(0xd7, videoTrackNumber),
    uintElement(0x73c5, videoTrackNumber),
    uintElement(0x83, 1),
    stringElement(0x86, input.videoCodecId),
    uintElement(0x23e383, Math.round(1_000_000_000 / input.frameRate)),
  ]

  if (input.hasAlpha) {
    videoElements.push(uintElement(0x53c0, 1))
    trackElements.push(uintElement(0x55ee, 1))
  }

  trackElements.push(masterElement(0xe0, videoElements))

  return masterElement(0xae, trackElements)
}

function createAudioTrackEntry(sampleRate: number, numberOfChannels: number): Uint8Array {
  return masterElement(0xae, [
    uintElement(0xd7, audioTrackNumber),
    uintElement(0x73c5, audioTrackNumber),
    uintElement(0x83, 2),
    stringElement(0x86, 'A_OPUS'),
    uintElement(0x56aa, 6_500_000),
    uintElement(0x56bb, 80_000_000),
    binaryElement(0x63a2, createOpusHead(sampleRate, numberOfChannels)),
    masterElement(0xe1, [
      floatElement(0xb5, sampleRate),
      uintElement(0x9f, numberOfChannels),
    ]),
  ])
}

function createClusters(chunks: EncodedTrackChunk[]): Uint8Array[] {
  const sortedChunks = [...chunks].sort((first, second) => {
    if (first.timestampUs !== second.timestampUs) {
      return first.timestampUs - second.timestampUs
    }

    return first.trackNumber - second.trackNumber
  })

  const clusters: Uint8Array[] = []
  let clusterStartMs = 0
  let clusterBlocks: Uint8Array[] = []
  const previousChunkTimeByTrack = new Map<number, number>()

  const flushCluster = () => {
    if (clusterBlocks.length === 0) {
      return
    }

    clusters.push(masterElement(0x1f43b675, [
      uintElement(0xe7, clusterStartMs),
      ...clusterBlocks,
    ]))
    clusterBlocks = []
  }

  sortedChunks.forEach((chunk, index) => {
    const chunkTimeMs = Math.max(0, Math.round(chunk.timestampUs / 1000))

    if (index === 0) {
      clusterStartMs = chunkTimeMs
    }

    if (chunkTimeMs - clusterStartMs >= clusterMaxDurationMs) {
      flushCluster()
      clusterStartMs = chunkTimeMs
    }

    if (chunk.alphaSideData && chunk.alphaSideData.byteLength > 0) {
      const blockGroupChildren = [
        binaryElement(0xa1, createBlockPayload({
          trackNumber: chunk.trackNumber,
          relativeTimeMs: chunkTimeMs - clusterStartMs,
          data: chunk.data,
        })),
        masterElement(0x75a1, [
          masterElement(0xa6, [
            uintElement(0xee, 1),
            binaryElement(0xa5, chunk.alphaSideData),
          ]),
        ]),
      ]
      const previousChunkTimeMs = previousChunkTimeByTrack.get(chunk.trackNumber)

      if (!chunk.keyFrame && previousChunkTimeMs !== undefined) {
        blockGroupChildren.push(intElement(0xfb, previousChunkTimeMs - chunkTimeMs))
      }

      clusterBlocks.push(masterElement(0xa0, blockGroupChildren))
    } else {
      clusterBlocks.push(binaryElement(0xa3, createBlockPayload({
        trackNumber: chunk.trackNumber,
        relativeTimeMs: chunkTimeMs - clusterStartMs,
        keyFrame: chunk.keyFrame,
        data: chunk.data,
      })))
    }

    previousChunkTimeByTrack.set(chunk.trackNumber, chunkTimeMs)
  })

  flushCluster()

  return clusters
}

function createBlockPayload(input: {
  trackNumber: number
  relativeTimeMs: number
  keyFrame?: boolean
  data: Uint8Array
}): Uint8Array {
  const block = new Uint8Array(4 + input.data.byteLength)
  const safeRelativeTime = Math.max(-32768, Math.min(32767, Math.round(input.relativeTimeMs)))

  block[0] = 0x80 | input.trackNumber
  block[1] = (safeRelativeTime >> 8) & 0xff
  block[2] = safeRelativeTime & 0xff
  block[3] = input.keyFrame ? 0x80 : 0
  block.set(input.data, 4)

  return block
}

function createOpusHead(sampleRate: number, numberOfChannels: number): Uint8Array {
  const opusHead = new Uint8Array(19)
  const view = new DataView(opusHead.buffer)

  opusHead.set(new TextEncoder().encode('OpusHead'), 0)
  opusHead[8] = 1
  opusHead[9] = numberOfChannels
  view.setUint16(10, 312, true)
  view.setUint32(12, sampleRate, true)
  view.setInt16(16, 0, true)
  opusHead[18] = 0

  return opusHead
}

function masterElement(id: number, children: Uint8Array[]): Uint8Array {
  return binaryElement(id, concatBytes(children))
}

function uintElement(id: number, value: number | bigint): Uint8Array {
  return binaryElement(id, encodeUnsignedInteger(value))
}

function intElement(id: number, value: number | bigint): Uint8Array {
  return binaryElement(id, encodeSignedInteger(value))
}

function floatElement(id: number, value: number): Uint8Array {
  const data = new Uint8Array(8)
  new DataView(data.buffer).setFloat64(0, value, false)
  return binaryElement(id, data)
}

function stringElement(id: number, value: string): Uint8Array {
  return binaryElement(id, new TextEncoder().encode(value))
}

function binaryElement(id: number, data: Uint8Array): Uint8Array {
  return concatBytes([encodeElementId(id), encodeElementSize(data.byteLength), data])
}

function encodeElementId(id: number): Uint8Array {
  const bytes: number[] = []
  let hasStarted = false

  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (id >> shift) & 0xff
    if (byte !== 0 || hasStarted) {
      bytes.push(byte)
      hasStarted = true
    }
  }

  return new Uint8Array(bytes.length > 0 ? bytes : [0])
}

function encodeElementSize(size: number): Uint8Array {
  const value = BigInt(size)

  for (let byteLength = 1; byteLength <= 8; byteLength += 1) {
    const maxValue = (1n << BigInt(byteLength * 7)) - 1n
    if (value < maxValue) {
      const bytes = new Uint8Array(byteLength)
      let remaining = value

      for (let index = byteLength - 1; index >= 0; index -= 1) {
        bytes[index] = Number(remaining & 0xffn)
        remaining >>= 8n
      }

      bytes[0] |= 1 << (8 - byteLength)
      return bytes
    }
  }

  throw new Error('WebM 数据过大，无法封装')
}

function encodeUnsignedInteger(value: number | bigint): Uint8Array {
  let remaining = BigInt(value)

  if (remaining <= 0n) {
    return new Uint8Array([0])
  }

  const bytes: number[] = []

  while (remaining > 0n) {
    bytes.unshift(Number(remaining & 0xffn))
    remaining >>= 8n
  }

  return new Uint8Array(bytes)
}

function encodeSignedInteger(value: number | bigint): Uint8Array {
  const integer = typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
  let byteLength = 1

  while (
    integer < -(1n << BigInt(byteLength * 8 - 1))
    || integer > (1n << BigInt(byteLength * 8 - 1)) - 1n
  ) {
    byteLength += 1
  }

  const bitLength = BigInt(byteLength * 8)
  let remaining = integer < 0 ? (1n << bitLength) + integer : integer
  const bytes = new Uint8Array(byteLength)

  for (let index = byteLength - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }

  return bytes
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0

  parts.forEach((part) => {
    result.set(part, offset)
    offset += part.byteLength
  })

  return result
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer as ArrayBuffer
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function normalizeExportRange(startTime: number, endTime: number, duration: number) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0.1
  const safeStart = clampNumber(startTime, 0, Math.max(0, safeDuration - 0.1))
  const safeEnd = clampNumber(endTime, safeStart + 0.1, safeDuration)

  return {
    startTime: safeStart,
    endTime: safeEnd,
    exportDuration: safeEnd - safeStart,
  }
}

export function createExportFilename(
  audioFileName: string,
  startTime: number,
  endTime: number,
  sourceDuration: number,
  extension: string,
): string {
  const baseName = stripExtension(audioFileName) || 'lrc-visualizer'
  const isFullExport = startTime <= 0.001 && Math.abs(endTime - sourceDuration) <= 0.05
  const rangeSuffix = isFullExport ? '' : `_${formatFileTime(startTime)}-${formatFileTime(endTime)}`
  return `${baseName}${rangeSuffix}.${extension}`
}

function formatFileTime(value: number): string {
  const totalTenths = Math.max(0, Math.round(value * 10))
  const minutes = Math.floor(totalTenths / 600)
  const seconds = Math.floor((totalTenths % 600) / 10)
  const tenths = totalTenths % 10
  return `${minutes.toString().padStart(2, '0')}m${seconds.toString().padStart(2, '0')}.${tenths}s`
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}
