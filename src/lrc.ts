export interface LyricWord {
  time: number
  text: string
}

export interface LyricLine {
  id: string
  time: number
  text: string
  words: LyricWord[]
}

export interface ParsedLrc {
  lines: LyricLine[]
  metadata: Record<string, string>
  encoding: string
}

const timePattern = /(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?/
const bracketTimePattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const wordTimePattern = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>([^<]*)/g
const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

export async function decodeLrcFile(file: File): Promise<{ text: string; encoding: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const bom = detectBom(bytes)

  if (bom) {
    return {
      text: new TextDecoder(bom).decode(bytes),
      encoding: bom.toUpperCase(),
    }
  }

  // A valid UTF-8 file must win before trying legacy Chinese encodings.  For
  // example, the UTF-8 bytes for a curly apostrophe in “don't” can be decoded
  // by GBK as characters such as “鈥…”.  The former scoring heuristic then
  // incorrectly favoured that mojibake because it looked like CJK text.
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding: 'UTF-8',
    }
  } catch {
    // Not valid UTF-8: continue with legacy encodings below.
  }

  const candidates = ['gb18030', 'gbk', 'big5', 'utf-16le']
  const decoded = candidates.map((encoding) => {
    try {
      return {
        encoding,
        text: new TextDecoder(encoding, { fatal: false }).decode(bytes),
      }
    } catch {
      return {
        encoding,
        text: '',
      }
    }
  })

  const best = decoded
    .filter((item) => item.text.length > 0)
    .sort((a, b) => scoreDecodedText(b.text) - scoreDecodedText(a.text))[0]

  return {
    text: best?.text ?? new TextDecoder().decode(bytes),
    encoding: (best?.encoding ?? 'utf-8').toUpperCase(),
  }
}

export function parseLrc(text: string, encoding = 'UTF-8'): ParsedLrc {
  const metadata: Record<string, string> = {}
  const sourceLines = text.replace(/\r\n?/g, '\n').split('\n')
  let offsetSeconds = 0

  for (const rawLine of sourceLines) {
    const metadataMatch = rawLine.match(/^\[([a-zA-Z]+):(.*)\]\s*$/)
    if (metadataMatch && !bracketTimePattern.test(rawLine)) {
      const key = metadataMatch[1].trim().toLowerCase()
      const value = metadataMatch[2].trim()
      metadata[key] = value

      if (key === 'offset') {
        const offsetMs = Number(value)
        offsetSeconds = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
      }
    }

    bracketTimePattern.lastIndex = 0
  }

  const lines: LyricLine[] = []

  sourceLines.forEach((rawLine, sourceIndex) => {
    bracketTimePattern.lastIndex = 0
    const matches = Array.from(rawLine.matchAll(bracketTimePattern))
    if (matches.length === 0) {
      return
    }

    const rawText = rawLine.replace(bracketTimePattern, '').trim()
    const words = parseWordTags(rawText, offsetSeconds)
    const textWithoutWordTags = rawText.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim()
    const visibleText = textWithoutWordTags.length > 0 ? textWithoutWordTags : rawText.trim()

    for (const match of matches) {
      const time = parseTimeParts(match[1], match[2], match[3]) + offsetSeconds
      lines.push({
        id: `${sourceIndex}-${match.index ?? 0}`,
        time: Math.max(0, time),
        text: visibleText,
        words,
      })
    }
  })

  lines.sort((a, b) => a.time - b.time)

  return {
    lines,
    metadata,
    encoding,
  }
}

export function getActiveLineIndex(lines: LyricLine[], currentTime: number): number {
  if (lines.length === 0 || currentTime < lines[0].time) {
    return -1
  }

  let low = 0
  let high = lines.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const line = lines[mid]
    const nextLine = lines[mid + 1]

    if (currentTime >= line.time && (!nextLine || currentTime < nextLine.time)) {
      return mid
    }

    if (currentTime < line.time) {
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return lines.length - 1
}

export function getLineProgress(
  lines: LyricLine[],
  index: number,
  currentTime: number,
  fallbackDuration: number,
): number {
  const line = lines[index]

  if (!line) {
    return 0
  }

  const nextLineTime = lines[index + 1]?.time
  const endTime = nextLineTime && nextLineTime > line.time
    ? nextLineTime
    : Math.max(fallbackDuration, line.time + 1.5)

  if (currentTime <= line.time) {
    return 0
  }

  if (currentTime >= endTime) {
    return 1
  }

  if (line.words.length > 0) {
    const timedWords = line.words.filter((word) => word.time >= line.time && word.time <= endTime)
    if (timedWords.length > 0) {
      if (currentTime < timedWords[0].time) {
        return 0
      }

      const lineGraphemes = splitLyricGraphemes(line.text)
      let searchCursor = 0

      for (let wordIndex = 0; wordIndex < timedWords.length; wordIndex += 1) {
        const word = timedWords[wordIndex]
        const nextWordTime = timedWords[wordIndex + 1]?.time ?? endTime
        const wordGraphemes = splitLyricGraphemes(word.text)
        const matchedStart = findGraphemeSequence(lineGraphemes, wordGraphemes, searchCursor)
        const wordStart = matchedStart >= 0 ? matchedStart : searchCursor
        const wordEnd = Math.min(lineGraphemes.length, wordStart + Math.max(1, wordGraphemes.length))

        if (currentTime < word.time) {
          return clamp(searchCursor / Math.max(1, lineGraphemes.length))
        }

        if (currentTime < nextWordTime || wordIndex === timedWords.length - 1) {
          const localProgress = clamp((currentTime - word.time) / Math.max(0.016, nextWordTime - word.time))
          return clamp((wordStart + (wordEnd - wordStart) * localProgress) / Math.max(1, lineGraphemes.length))
        }

        searchCursor = wordEnd
      }
    }
  }

  return clamp((currentTime - line.time) / Math.max(0.1, endTime - line.time))
}

export function splitLyricGraphemes(text: string): string[] {
  if (!text) {
    return []
  }

  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
  }

  return Array.from(text)
}

function findGraphemeSequence(source: string[], target: string[], fromIndex: number): number {
  if (target.length === 0) {
    return fromIndex
  }

  for (let index = fromIndex; index <= source.length - target.length; index += 1) {
    let matches = true

    for (let targetIndex = 0; targetIndex < target.length; targetIndex += 1) {
      if (source[index + targetIndex] !== target[targetIndex]) {
        matches = false
        break
      }
    }

    if (matches) {
      return index
    }
  }

  return -1
}

function parseWordTags(rawText: string, offsetSeconds: number): LyricWord[] {
  wordTimePattern.lastIndex = 0
  const words: LyricWord[] = []

  for (const match of rawText.matchAll(wordTimePattern)) {
    const parsedTime = parseTimeParts(match[1], match[2], match[3])
    const text = match[4]
    if (text.length > 0) {
      words.push({
        time: Math.max(0, parsedTime + offsetSeconds),
        text,
      })
    }
  }

  return words.sort((a, b) => a.time - b.time)
}

function parseTimeParts(minutes: string, seconds: string, fraction = '0'): number {
  const parsed = `${minutes}:${seconds}.${fraction}`.match(timePattern)

  if (!parsed) {
    return 0
  }

  const minuteValue = Number(parsed[1])
  const secondValue = Number(parsed[2])
  const millisecondValue = Number(parsed[3].padEnd(3, '0').slice(0, 3))

  return minuteValue * 60 + secondValue + millisecondValue / 1000
}

function detectBom(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8'
  }

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le'
  }

  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be'
  }

  return null
}

function scoreDecodedText(text: string): number {
  const replacementCount = countMatches(text, /\uFFFD/g)
  const controlCount = Array.from(text).filter((char) => {
    const code = char.charCodeAt(0)
    return code < 32 && char !== '\n' && char !== '\r' && char !== '\t'
  }).length
  const lrcTagCount = countMatches(text, /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g)
  const cjkCount = countMatches(text, /[\u3400-\u9fff]/g)
  const mojibakeCount = countMatches(text, /[ÃÂ�]/g)

  return lrcTagCount * 120 + cjkCount * 1.5 - replacementCount * 240 - controlCount * 50 - mojibakeCount * 30
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}
