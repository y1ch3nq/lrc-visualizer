import { type LyricLine } from './lrc.ts'
import {
  drawVisualizer,
  fitCanvasToSettings,
  getTikTokWordFrameTimeline,
  type VisualizerSettings,
} from './renderer.ts'

const maximumFrameCount = 2_000

export interface TikTokFrameExportInput {
  lines: LyricLine[]
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
  onProgress: (progress: number, currentTime: number, frameCount: number) => void
}

export interface TikTokFrameExportResult {
  url: string
  filename: string
  mimeType: 'application/zip'
  frameCount: number
}

interface ZipEntry {
  name: string
  data: Uint8Array<ArrayBuffer>
  crc32: number
  offset: number
}

/**
 * Renders the static state at the beginning of a clip and after each lyric
 * word reveal. PNGs are stored in a ZIP so browsers do not block a large
 * series of individual downloads.
 */
export async function exportTikTokWordFrames(input: TikTokFrameExportInput): Promise<TikTokFrameExportResult> {
  if (input.settings.visualStyle !== 'tiktok') {
    throw new Error('逐词 PNG 序列仅适用于黑白歌词模式')
  }

  const startTime = Math.max(0, Math.min(input.startTime, input.endTime))
  const endTime = Math.max(startTime, Math.max(input.startTime, input.endTime))
  const timeline = getTikTokWordFrameTimeline(input.lines, input.duration, startTime, endTime)

  if (timeline.length === 0) {
    throw new Error('所选片段内没有可导出的歌词状态')
  }

  if (timeline.length > maximumFrameCount) {
    throw new Error(`当前片段会生成 ${timeline.length} 张 PNG，超过 ${maximumFrameCount} 张上限；请缩短导出范围`)
  }

  const canvas = document.createElement('canvas')
  fitCanvasToSettings(canvas, input.settings)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('无法创建 PNG 导出画布')
  }

  const entries: ZipEntry[] = []
  input.onProgress(0, timeline[0].time, timeline.length)

  for (let index = 0; index < timeline.length; index += 1) {
    const frame = timeline[index]
    drawVisualizer({
      ctx,
      lines: input.lines,
      currentTime: frame.time,
      duration: input.duration,
      settings: input.settings,
      title: input.title,
      artist: input.artist,
      coverImage: input.coverImage,
      backgroundImage: input.backgroundImage,
      brandIconImage: input.brandIconImage,
      sodaBrandText: input.sodaBrandText,
      sodaPlaylistText: input.sodaPlaylistText,
    })

    const png = new Uint8Array(await canvasToPng(canvas))
    entries.push({
      name: `${String(index + 1).padStart(4, '0')}_${formatFrameTime(frame.time)}.png`,
      data: png,
      crc32: crc32(png),
      offset: 0,
    })

    const progress = (index + 1) / timeline.length
    input.onProgress(progress, frame.time, timeline.length)

    // Give the browser a chance to paint progress during longer exports.
    if ((index + 1) % 8 === 0 && index + 1 < timeline.length) {
      await nextPaint()
    }
  }

  const zip = createStoredZip(entries)
  const url = URL.createObjectURL(zip)
  return {
    url,
    filename: `${safeFilename(input.title || 'lyrics')}-tiktok-word-frames.zip`,
    mimeType: 'application/zip',
    frameCount: entries.length,
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('PNG 编码失败'))
        return
      }
      resolve(await blob.arrayBuffer())
    }, 'image/png')
  })
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()))
}

function createStoredZip(entries: ZipEntry[]): Blob {
  const parts: BlobPart[] = []
  let offset = 0

  entries.forEach((entry) => {
    const name = new TextEncoder().encode(entry.name)
    entry.offset = offset
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint32(14, entry.crc32, true)
    view.setUint32(18, entry.data.length, true)
    view.setUint32(22, entry.data.length, true)
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true)
    header.set(name, 30)
    parts.push(header, entry.data)
    offset += header.length + entry.data.length
  })

  const centralDirectoryOffset = offset
  entries.forEach((entry) => {
    const name = new TextEncoder().encode(entry.name)
    const header = new Uint8Array(46 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, 0x0800, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint16(14, 0, true)
    view.setUint32(16, entry.crc32, true)
    view.setUint32(20, entry.data.length, true)
    view.setUint32(24, entry.data.length, true)
    view.setUint16(28, name.length, true)
    view.setUint16(30, 0, true)
    view.setUint16(32, 0, true)
    view.setUint16(34, 0, true)
    view.setUint16(36, 0, true)
    view.setUint32(38, 0, true)
    view.setUint32(42, entry.offset, true)
    header.set(name, 46)
    parts.push(header)
    offset += header.length
  })

  const centralDirectorySize = offset - centralDirectoryOffset
  const trailer = new Uint8Array(22)
  const trailerView = new DataView(trailer.buffer)
  trailerView.setUint32(0, 0x06054b50, true)
  trailerView.setUint16(4, 0, true)
  trailerView.setUint16(6, 0, true)
  trailerView.setUint16(8, entries.length, true)
  trailerView.setUint16(10, entries.length, true)
  trailerView.setUint32(12, centralDirectorySize, true)
  trailerView.setUint32(16, centralDirectoryOffset, true)
  trailerView.setUint16(20, 0, true)
  parts.push(trailer)

  return new Blob(parts, { type: 'application/zip' })
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function formatFrameTime(time: number): string {
  const milliseconds = Math.max(0, Math.round(time * 1_000))
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor(milliseconds / 1_000) % 60
  const remainder = milliseconds % 1_000
  return `${String(minutes).padStart(2, '0')}-${String(seconds).padStart(2, '0')}-${String(remainder).padStart(3, '0')}`
}

function safeFilename(value: string): string {
  const compact = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 72)
  return compact || 'lyrics'
}
