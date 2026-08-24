import {
  getActiveLineIndex,
  getLineProgress,
  splitLyricGraphemes,
  type LyricLine,
} from './lrc.ts'

export interface VisualizerSettings {
  width: number
  height: number
  backgroundColor: string
  transparentBackground: boolean
  backgroundImageBlur: number
  backgroundImageDarkness: number
  lyricColor: string
  progressColor: string
  lyricHighlightMode: 'animated' | 'instant' | 'focus'
  nextColor: string
  metaColor: string
  chineseFont: string
  englishFont: string
  fontSize: number
  metadataTitleFontSize: number
  metadataArtistFontSize: number
  sodaBrandFontSize: number
  sodaPlaylistFontSize: number
  lineGap: number
  visibleLineCount: number
  lyricAlignment: 'center' | 'left'
  visualStyle: 'classic' | 'soda' | 'single' | 'tiktok'
  tiktokTextBlur: number
  singleWaveSpeedRamp: boolean
  showBeatBar: boolean
  showMetadata: boolean
  showProgressBar: boolean
}

export interface TikTokWordFrameTimelineEntry {
  time: number
  kind: 'range-start' | 'word-reveal'
}

interface DrawInput {
  ctx: VisualizerCanvasContext
  lines: LyricLine[]
  currentTime: number
  duration: number
  settings: VisualizerSettings
  title?: string
  artist?: string
  coverImage?: CanvasImageSource
  backgroundImage?: CanvasImageSource
  brandIconImage?: CanvasImageSource
  sodaBrandText?: string
  sodaPlaylistText?: string
  beatStrength?: number
  renderScale?: number
}

interface TextSegment {
  text: string
  font: string
  width?: number
}

interface PreparedText {
  segments: TextSegment[]
  size: number
  width: number
}

interface PreparedRow extends PreparedText {
  startGrapheme: number
  endGrapheme: number
  graphemeAdvances: number[]
  glyphs: PreparedGlyph[]
}

interface PreparedGlyph {
  text: string
  font: string
  width: number
}

interface PreparedLine {
  rows: PreparedRow[]
  height: number
  lineHeight: number
  graphemeCount: number
}

interface PositionedLine {
  index: number
  line: LyricLine
  layout: PreparedLine
  center: number
}

interface LineTone {
  alpha: number
}

interface LyricFocusMotion {
  alpha: number
  blur: number
  scale: number
  translateY: number
}

interface LyricLineWave {
  translateX: number
  translateY: number
  rotation: number
  scaleX: number
  scaleY: number
}

interface SingleLyricWaveTiming {
  phase: number
  intensity: number
}

interface SingleAtmosphereCoverCache {
  canvas: OffscreenCanvas | HTMLCanvasElement
  width: number
  height: number
  renderScale: number
  coverImage: CanvasImageSource
}

interface TikTokWordLayout {
  tokenIndex: number
  metrics: PreparedText
}

interface TikTokRowLayout {
  words: TikTokWordLayout[]
  contentWidth: number
}

interface TikTokPageLayout {
  rows: TikTokRowLayout[]
  firstTokenIndex: number
}

interface TikTokLyricLayout {
  fontSize: number
  lineHeight: number
  maxWidth: number
  pages: TikTokPageLayout[]
  tokenCount: number
}

interface CustomBackgroundCache {
  canvas: OffscreenCanvas | HTMLCanvasElement
  width: number
  height: number
  renderScale: number
  blur: number
  image: CanvasImageSource
}

export type VisualizerCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const defaultChineseFont = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const defaultEnglishFont = 'Inter, "SF Pro Display", Arial, sans-serif'
const sodaUiChineseFont = '"Douyin Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const sodaUiEnglishFont = '"SF Pro Display", Inter, Arial, sans-serif'
const lyricLayoutCache = new Map<string, PreparedLine>()
const lyricLayoutCacheLimit = 720
const tiktokLayoutCache = new Map<string, TikTokLyricLayout>()
const tiktokLayoutCacheLimit = 360
const lyricWeight = 600
let singleAtmosphereCoverCache: SingleAtmosphereCoverCache | null = null
let customBackgroundCache: CustomBackgroundCache | null = null

export function drawVisualizer(input: DrawInput): void {
  const {
    ctx,
    lines,
    currentTime,
    duration,
    settings,
    title,
    artist,
    coverImage,
    backgroundImage,
    brandIconImage,
    sodaBrandText,
    sodaPlaylistText,
  } = input
  const renderScale = clampNumber(input.renderScale ?? 1, 0.1, 1)

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0)

  drawBackground(ctx, settings, coverImage, backgroundImage, currentTime, renderScale)

  if (settings.showMetadata && settings.visualStyle !== 'single' && settings.visualStyle !== 'tiktok') {
    if (settings.visualStyle === 'soda') {
      drawSodaMetadata(ctx, settings, title, artist, coverImage, brandIconImage, sodaBrandText, sodaPlaylistText)
    } else {
      drawMetadata(ctx, settings, title, artist)
    }
  }

  const activeIndex = getActiveLineIndex(lines, currentTime)
  const focusIndex = activeIndex >= 0 ? activeIndex : lines.length > 0 ? 0 : -1

  if (focusIndex >= 0) {
    if (settings.visualStyle === 'single') {
      drawSingleLyric(ctx, lines, focusIndex, activeIndex, currentTime, settings)
    } else if (settings.visualStyle === 'tiktok') {
      drawTikTokLyric(ctx, lines, focusIndex, activeIndex, currentTime, duration, settings)
    } else {
      drawLyricRail(ctx, lines, focusIndex, activeIndex, currentTime, duration, settings)
    }
  } else {
    drawEmptyState(ctx, settings)
  }

  if (settings.showProgressBar && settings.visualStyle !== 'single' && settings.visualStyle !== 'tiktok') {
    drawProgressBar(ctx, settings, currentTime, duration)
  }

  if (settings.showBeatBar && settings.visualStyle !== 'tiktok') {
    drawBeatReactiveBar(ctx, settings, currentTime, clamp(input.beatStrength ?? 0))
  }
}

export function fitCanvasToSettings(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  settings: VisualizerSettings,
  renderScale = 1,
): void {
  const targetWidth = Math.max(1, Math.round(settings.width * renderScale))
  const targetHeight = Math.max(1, Math.round(settings.height * renderScale))

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }
}

/**
 * Returns the static visual states needed for the black-and-white TikTok
 * template: one at the beginning of the selected range when necessary, then
 * one whenever one or more lyric tokens become visible.
 */
export function getTikTokWordFrameTimeline(
  lines: LyricLine[],
  duration: number,
  rangeStart: number,
  rangeEnd: number,
): TikTokWordFrameTimelineEntry[] {
  const safeStart = Math.max(0, Math.min(rangeStart, rangeEnd))
  const safeEnd = Math.max(safeStart, Math.max(rangeStart, rangeEnd))
  const events = new Map<string, number>()

  lines.forEach((line, index) => {
    const nextLineTime = lines[index + 1]?.time
    const displayEndTime = nextLineTime ?? Math.max(duration, line.time + 2.4)
    const explicitRevealEndTime = line.endTime && line.endTime > line.time
      ? line.endTime
      : undefined
    const revealEndTime = explicitRevealEndTime
      ? Math.min(displayEndTime, explicitRevealEndTime)
      : displayEndTime
    const tokenCount = tokenizeTikTokText(line.text).length
    if (tokenCount === 0) {
      return
    }

    resolveTikTokRevealTimes(line, tokenCount, revealEndTime).forEach((time) => {
      if (time < safeStart - 0.0005 || time > safeEnd + 0.0005) {
        return
      }
      const boundedTime = Math.max(safeStart, Math.min(safeEnd, time))
      events.set(boundedTime.toFixed(5), boundedTime)
    })
  })

  const revealTimes = Array.from(events.values()).sort((left, right) => left - right)
  const needsRangeStart = revealTimes.length === 0 || Math.abs(revealTimes[0] - safeStart) > 0.0005
  const timeline: TikTokWordFrameTimelineEntry[] = needsRangeStart
    ? [{ time: safeStart, kind: 'range-start' }]
    : []

  timeline.push(...revealTimes.map((time) => ({ time, kind: 'word-reveal' as const })))
  return timeline
}

function drawLyricRail(
  ctx: VisualizerCanvasContext,
  lines: LyricLine[],
  focusIndex: number,
  activeIndex: number,
  currentTime: number,
  duration: number,
  settings: VisualizerSettings,
): void {
  const isPortrait = settings.height > settings.width
  const visibleCount = clampInteger(settings.visibleLineCount, 3, 15)
  const isSoda = settings.visualStyle === 'soda' && isPortrait
  const sodaHasHeader = isSoda && settings.showMetadata
  // In the Soda layout the metadata card ends at 45.5% of the canvas. Keep a
  // small protected strip immediately below it: outgoing lyrics fade out here
  // instead of visually running into the card.
  const sodaCardBottomY = settings.height * 0.455
  const topY = sodaHasHeader
    ? sodaCardBottomY + settings.height * 0.006
    : settings.height * (settings.showMetadata ? 0.22 : 0.075)
  const bottomY = settings.height * (settings.showProgressBar ? 0.835 : 0.925)
  const aboveCount = Math.max(2, Math.floor((visibleCount - 1) * (isPortrait ? 0.38 : 0.5)))
  const belowCount = visibleCount - aboveCount - 1
  const align: CanvasTextAlign = isSoda ? 'left' : settings.lyricAlignment
  const textX = align === 'left' ? settings.width * 0.075 : settings.width / 2
  const maxTextWidth = settings.width * (align === 'left' ? 0.85 : 0.82)
  const layoutStart = Math.max(0, focusIndex - Math.max(aboveCount + 4, 10))
  const layoutEnd = Math.min(lines.length - 1, focusIndex + belowCount + 4)
  const positionedLines = buildPositionedLines(
    ctx,
    lines,
    layoutStart,
    layoutEnd,
    maxTextWidth,
    settings,
  )
  const cameraCenter = resolveCameraCenter(positionedLines, lines, focusIndex, currentTime)
  const transitionProgress = resolveLineTransitionProgress(lines, activeIndex, currentTime)
  const focusEntry = positionedLines.find((entry) => entry.index === focusIndex)
  // A fixed Soda anchor made every lyric sit too low. Anchor its settled
  // position by the focus line's *top* instead: a single line lands in the
  // former compact position while a wrapped two-line lyric is lifted enough
  // to preserve the same comfortable distance to the information card.
  const anchorY = isSoda && sodaHasHeader && focusEntry
    ? sodaCardBottomY + settings.height * 0.03 + focusEntry.layout.height / 2
    : isSoda
      ? settings.height * 0.505
      : topY + (bottomY - topY) * (isPortrait ? 0.38 : 0.46)

  for (const entry of positionedLines) {
    const y = anchorY + entry.center - cameraCenter
    const halfHeight = entry.layout.height * 0.56

    if (y + halfHeight < topY || y - halfHeight > bottomY) {
      continue
    }

    const tone = resolveLineTone(entry.index, focusIndex, activeIndex, transitionProgress, isSoda)
    const edgeAlpha = resolveEdgeAlpha(
      y,
      halfHeight,
      topY,
      bottomY,
      isSoda && sodaHasHeader ? 0.05 : 0.12,
      isSoda && sodaHasHeader ? 1.85 : 1,
    )

    if (tone.alpha * edgeAlpha <= 0.015) {
      continue
    }

    ctx.save()
    ctx.globalAlpha = tone.alpha * edgeAlpha

    if (entry.index === activeIndex) {
      const focusMotion = settings.lyricHighlightMode === 'focus'
        ? resolveLyricFocusMotion(lines, activeIndex, currentTime, settings.fontSize)
        : null

      if (focusMotion) {
        ctx.globalAlpha *= focusMotion.alpha
        ctx.filter = focusMotion.blur > 0.01 ? `blur(${focusMotion.blur.toFixed(2)}px)` : 'none'
        ctx.translate(textX, y + focusMotion.translateY)
        ctx.scale(focusMotion.scale, focusMotion.scale)
        ctx.translate(-textX, -y)
      }

      const progress = settings.lyricHighlightMode === 'instant'
        ? 1
        : getLineProgress(lines, activeIndex, currentTime, duration)

      drawProgressPreparedLine({
        ctx,
        layout: entry.layout,
        x: textX,
        y,
        align,
        baseColor: settings.lyricColor,
        progressColor: settings.progressColor,
        progress,
      })
    } else {
      const color = activeIndex < 0 && entry.index === focusIndex
        ? settings.lyricColor
        : settings.nextColor
      drawPreparedLine(ctx, entry.layout, textX, y, align, color)
    }

    ctx.restore()
  }
}

/**
 * The single-line scene deliberately avoids a scrolling rail. It uses the
 * LRC timeline as the animation clock, so scrubbing and exported frames are
 * identical to the live preview. New lyrics arrive soft and displaced, then
 * settle into focus; the previous lyric dissipates underneath it.
 */
function drawSingleLyric(
  ctx: VisualizerCanvasContext,
  lines: LyricLine[],
  focusIndex: number,
  activeIndex: number,
  currentTime: number,
  settings: VisualizerSettings,
): void {
  const index = activeIndex >= 0 ? activeIndex : focusIndex
  const line = lines[index]
  if (!line) {
    return
  }

  const sceneSettings = getSingleLyricSettings(settings)
  const textX = settings.width / 2
  const textY = settings.height * (settings.height > settings.width ? 0.47 : 0.5)
  const maxTextWidth = settings.width * (settings.height > settings.width ? 0.84 : 0.78)
  const elapsed = Math.max(0, currentTime - line.time)
  const activeLayout = getPreparedLine(ctx, line.text, maxTextWidth, sceneSettings)
  const activeMotion = resolveSingleLyricMotion(
    lines,
    index,
    currentTime,
    sceneSettings.fontSize,
    settings.singleWaveSpeedRamp,
  )
  const activeWaveTiming = resolveSingleLyricWaveTiming(lines, index, currentTime, settings.singleWaveSpeedRamp)

  // Keep a short, vapor-like tail from the prior lyric. It is intentionally
  // below the incoming line so the new phrase remains readable even at a
  // fast lyric change.
  if (index > 0 && elapsed < 0.46) {
    const previousLine = lines[index - 1]
    if (previousLine) {
      const leave = clamp(elapsed / 0.46)
      const previousLayout = getPreparedLine(ctx, previousLine.text, maxTextWidth, sceneSettings)
      ctx.save()
      ctx.globalAlpha = Math.pow(1 - leave, 1.8) * 0.54
      ctx.filter = `blur(${(sceneSettings.fontSize * (0.035 + leave * 0.095)).toFixed(2)}px)`
      ctx.translate(textX, textY - sceneSettings.fontSize * 0.035 - leave * sceneSettings.fontSize * 0.17)
      const outgoingScale = 1 + leave * 0.07
      ctx.scale(outgoingScale, outgoingScale)
      ctx.translate(-textX, -textY)
      const previousWaveTiming = resolveSingleLyricWaveTiming(lines, index - 1, currentTime, settings.singleWaveSpeedRamp)
      const previousWave = resolveLyricLineWave(
        index - 1,
        currentTime,
        sceneSettings.fontSize,
        (0.7 + leave * 0.45) * previousWaveTiming.intensity,
        previousWaveTiming.phase,
      )
      applyLyricLineWave(ctx, previousWave, textX, textY)
      drawGlyphWavePreparedLine({
        ctx,
        layout: previousLayout,
        x: textX,
        y: textY,
        align: 'center',
        color: settings.nextColor,
        phase: previousWaveTiming.phase,
        intensity: (0.62 + leave * 0.32) * previousWaveTiming.intensity,
      })
      ctx.restore()
    }
  }

  ctx.save()
  ctx.globalAlpha = activeMotion.alpha
  ctx.filter = activeMotion.blur > 0.01 ? `blur(${activeMotion.blur.toFixed(2)}px)` : 'none'
  ctx.translate(textX, textY + activeMotion.translateY)
  ctx.scale(activeMotion.scale, activeMotion.scale)
  ctx.translate(-textX, -textY)
  const activeWave = resolveLyricLineWave(
    index,
    currentTime,
    sceneSettings.fontSize,
    1.2 * activeWaveTiming.intensity,
    activeWaveTiming.phase,
  )
  applyLyricLineWave(ctx, activeWave, textX, textY)
  drawGlyphWavePreparedLine({
    ctx,
    layout: activeLayout,
    x: textX,
    y: textY,
    align: 'center',
    color: settings.lyricColor,
    phase: activeWaveTiming.phase,
    intensity: activeWaveTiming.intensity,
  })
  ctx.restore()
}

function drawTikTokLyric(
  ctx: VisualizerCanvasContext,
  lines: LyricLine[],
  focusIndex: number,
  activeIndex: number,
  currentTime: number,
  duration: number,
  settings: VisualizerSettings,
): void {
  const index = activeIndex >= 0 ? activeIndex : focusIndex
  const line = lines[index]

  if (!line || currentTime < line.time) {
    return
  }

  const followingLineTime = lines[index + 1]?.time
  const displayEndTime = followingLineTime ?? Math.max(duration, line.time + 2.4)
  const explicitRevealEndTime = line.endTime && line.endTime > line.time
    ? line.endTime
    : undefined
  const revealEndTime = explicitRevealEndTime
    ? Math.min(displayEndTime, explicitRevealEndTime)
    : displayEndTime

  if (currentTime >= displayEndTime) {
    return
  }

  const layout = getTikTokLyricLayout(ctx, line.text, settings)
  if (layout.tokenCount === 0 || layout.pages.length === 0) {
    return
  }

  const revealTimes = resolveTikTokRevealTimes(line, layout.tokenCount, revealEndTime)
  let activePage = layout.pages[0]
  for (const page of layout.pages) {
    if (currentTime + 0.008 >= (revealTimes[page.firstTokenIndex] ?? line.time)) {
      activePage = page
    } else {
      break
    }
  }
  const x = settings.width * 0.24
  const firstBaseline = settings.height / 2 - (activePage.rows.length - 1) * layout.lineHeight / 2
  const panelHeight = Math.min(settings.width, settings.height)
  const panelTop = (settings.height - panelHeight) / 2

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, panelTop, settings.width, panelHeight)
  ctx.clip()
  ctx.fillStyle = settings.lyricColor || '#050505'
  if (settings.tiktokTextBlur > 0) {
    ctx.filter = `blur(${clampNumber(settings.tiktokTextBlur, 0, 12).toFixed(2)}px)`
  }

  activePage.rows.forEach((row, rowIndex) => {
    const visibleWords = row.words.filter((word) => currentTime + 0.008 >= (revealTimes[word.tokenIndex] ?? line.time))
    if (visibleWords.length === 0) {
      return
    }

    const isLastRow = rowIndex === activePage.rows.length - 1
    const gapCount = Math.max(0, row.words.length - 1)
    const naturalGap = measureText(ctx, ' ', settings, layout.fontSize, 400)
    const justifiedGap = !isLastRow && gapCount > 0
      ? Math.max(naturalGap, (layout.maxWidth - row.contentWidth) / gapCount)
      : naturalGap
    let cursorX = x

    row.words.forEach((word, wordIndex) => {
      if (currentTime + 0.008 >= (revealTimes[word.tokenIndex] ?? line.time)) {
        drawMixedTextWithMetrics(
          ctx,
          word.metrics,
          cursorX,
          firstBaseline + rowIndex * layout.lineHeight,
          settings.lyricColor || '#050505',
          false,
        )
      }

      cursorX += word.metrics.width
      if (wordIndex < row.words.length - 1) {
        cursorX += justifiedGap
      }
    })
  })

  ctx.restore()
}

function getTikTokLyricLayout(
  ctx: VisualizerCanvasContext,
  text: string,
  settings: VisualizerSettings,
): TikTokLyricLayout {
  const cacheKey = [
    text,
    settings.width,
    settings.height,
    settings.fontSize,
    settings.chineseFont,
    settings.englishFont,
  ].join('\u0001')
  const cached = tiktokLayoutCache.get(cacheKey)

  if (cached) {
    tiktokLayoutCache.delete(cacheKey)
    tiktokLayoutCache.set(cacheKey, cached)
    return cached
  }

  const tokens = tokenizeTikTokText(text)
  const maxWidth = settings.width * 0.47
  let fontSize = clampNumber(settings.fontSize, 36, settings.width * 0.19)
  let rows: TikTokRowLayout[] = []

  while (fontSize >= 36) {
    rows = buildTikTokRows(ctx, tokens, maxWidth, fontSize, settings)
    const widestWord = rows.reduce(
      (maximum, row) => Math.max(maximum, ...row.words.map((word) => word.metrics.width)),
      0,
    )
    if (widestWord <= maxWidth) {
      break
    }
    fontSize *= 0.92
  }

  rows = rebalanceTikTokOrphanRow(rows, maxWidth, settings, fontSize, ctx)
  const pages = paginateTikTokRows(rows)

  const layout: TikTokLyricLayout = {
    fontSize,
    lineHeight: fontSize * 1.035,
    maxWidth,
    pages,
    tokenCount: tokens.length,
  }

  if (tiktokLayoutCache.size >= tiktokLayoutCacheLimit) {
    const oldestKey = tiktokLayoutCache.keys().next().value
    if (oldestKey) {
      tiktokLayoutCache.delete(oldestKey)
    }
  }
  tiktokLayoutCache.set(cacheKey, layout)
  return layout
}

function buildTikTokRows(
  ctx: VisualizerCanvasContext,
  tokens: string[],
  maxWidth: number,
  fontSize: number,
  settings: VisualizerSettings,
): TikTokRowLayout[] {
  const naturalGap = measureText(ctx, ' ', settings, fontSize, 400)
  const rows: TikTokRowLayout[] = []
  let words: TikTokWordLayout[] = []
  let contentWidth = 0

  tokens.forEach((token, tokenIndex) => {
    const segments = segmentText(token, settings, fontSize, 400)
    const metrics: PreparedText = {
      segments,
      size: fontSize,
      width: measureSegments(ctx, segments),
    }
    const proposedWidth = contentWidth
      + (words.length > 0 ? naturalGap : 0)
      + metrics.width

    if (words.length > 0 && proposedWidth > maxWidth) {
      rows.push({ words, contentWidth })
      words = []
      contentWidth = 0
    }

    if (words.length > 0) {
      contentWidth += naturalGap
    }
    words.push({ tokenIndex, metrics })
    contentWidth += metrics.width
  })

  if (words.length > 0) {
    rows.push({ words, contentWidth })
  }

  return rows
}

function rebalanceTikTokOrphanRow(
  rows: TikTokRowLayout[],
  maxWidth: number,
  settings: VisualizerSettings,
  fontSize: number,
  ctx: VisualizerCanvasContext,
): TikTokRowLayout[] {
  if (rows.length < 2) {
    return rows
  }

  const lastRow = rows[rows.length - 1]
  const previousRow = rows[rows.length - 2]
  if (lastRow.words.length !== 1 || previousRow.words.length < 2) {
    return rows
  }

  const naturalGap = measureText(ctx, ' ', settings, fontSize, 400)
  let best: { previous: TikTokRowLayout; last: TikTokRowLayout; score: number } | null = null

  for (let moveCount = 1; moveCount < previousRow.words.length; moveCount += 1) {
    const splitIndex = previousRow.words.length - moveCount
    const previousWords = previousRow.words.slice(0, splitIndex)
    const lastWords = [...previousRow.words.slice(splitIndex), ...lastRow.words]
    const previousWidth = getTikTokRowContentWidth(previousWords, naturalGap)
    const lastWidth = getTikTokRowContentWidth(lastWords, naturalGap)

    if (previousWidth > maxWidth || lastWidth > maxWidth) {
      continue
    }

    const singleWordPenalty = previousWords.length === 1 ? maxWidth * 0.24 : 0
    const score = Math.abs(previousWidth - lastWidth) + singleWordPenalty
    if (!best || score < best.score) {
      best = {
        previous: { words: previousWords, contentWidth: previousWidth },
        last: { words: lastWords, contentWidth: lastWidth },
        score,
      }
    }
  }

  if (!best) {
    return rows
  }

  return [...rows.slice(0, -2), best.previous, best.last]
}

function getTikTokRowContentWidth(words: TikTokWordLayout[], gap: number): number {
  return words.reduce((sum, word) => sum + word.metrics.width, 0)
    + Math.max(0, words.length - 1) * gap
}

function paginateTikTokRows(rows: TikTokRowLayout[]): TikTokPageLayout[] {
  const pages: TikTokPageLayout[] = []
  let rowIndex = 0

  while (rowIndex < rows.length) {
    const remaining = rows.length - rowIndex
    const pageSize = remaining === 4 ? 2 : Math.min(3, remaining)
    const pageRows = rows.slice(rowIndex, rowIndex + pageSize)
    pages.push({
      rows: pageRows,
      firstTokenIndex: pageRows[0]?.words[0]?.tokenIndex ?? 0,
    })
    rowIndex += pageSize
  }

  return pages
}

function tokenizeTikTokText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }

  const spacedTokens = trimmed.match(/\S+/gu) ?? []
  if (spacedTokens.length > 1 || !Array.from(trimmed).some(isCjk)) {
    return spacedTokens
  }

  return splitLyricGraphemes(trimmed).filter((token) => !isWhitespace(token))
}

function resolveTikTokRevealTimes(line: LyricLine, tokenCount: number, nextLineTime: number): number[] {
  const explicitTimes = line.words.flatMap((word) => {
    const count = Math.max(1, tokenizeTikTokText(word.text).length)
    return Array.from({ length: count }, () => word.time)
  })

  if (explicitTimes.length >= tokenCount) {
    return explicitTimes.slice(0, tokenCount).map((time) => Math.min(nextLineTime - 0.01, Math.max(line.time, time)))
  }

  const tokens = tokenizeTikTokText(line.text)
  const lineDuration = Math.max(0.24, nextLineTime - line.time)
  const revealSpan = Math.max(0.08, lineDuration * 0.82)
  const weights = tokens.map((token) => Math.max(1, Math.sqrt(splitLyricGraphemes(token).length)))
  const totalWeight = Math.max(1, weights.reduce((sum, weight) => sum + weight, 0))
  let elapsedWeight = 0

  return Array.from({ length: tokenCount }, (_, index) => {
    const time = line.time + revealSpan * elapsedWeight / totalWeight
    elapsedWeight += weights[index] ?? 1
    return time
  })
}

function getSingleLyricSettings(settings: VisualizerSettings): VisualizerSettings {
  const scale = settings.height > settings.width ? 1.72 : 1.48
  const maximum = settings.width * (settings.height > settings.width ? 0.132 : 0.105)
  return {
    ...settings,
    fontSize: Math.round(Math.max(settings.fontSize, Math.min(maximum, settings.fontSize * scale))),
  }
}

function resolveSingleLyricMotion(
  lines: LyricLine[],
  activeIndex: number,
  currentTime: number,
  fontSize: number,
  useSpeedRamp: boolean,
): {
  alpha: number
  blur: number
  scale: number
  translateY: number
} {
  const lineStart = lines[activeIndex]?.time ?? currentTime
  const nextStart = lines[activeIndex + 1]?.time
  const duration = nextStart === undefined ? 2.6 : Math.max(0.22, nextStart - lineStart)
  const elapsed = Math.max(0, currentTime - lineStart)
  const entryDuration = useSpeedRamp
    ? Math.min(0.42, Math.max(0.2, duration * 0.18))
    : Math.min(0.62, Math.max(0.3, duration * 0.28))
  const entry = 1 - Math.pow(1 - clamp(elapsed / entryDuration), 3)
  const settlingPulse = Math.sin(entry * Math.PI) * 0.024
  const breathing = Math.sin(elapsed * 1.85) * 0.004

  return {
    alpha: useSpeedRamp ? 0.54 + entry * 0.46 : 0.12 + entry * 0.88,
    blur: useSpeedRamp
      ? (1 - entry) * Math.min(4.5, Math.max(2, fontSize * 0.04))
      : (1 - entry) * Math.max(8, fontSize * 0.13),
    scale: (useSpeedRamp ? 0.965 + entry * 0.035 : 0.905 + entry * 0.095) + settlingPulse + breathing,
    translateY: (1 - entry) * fontSize * (useSpeedRamp ? -0.18 : 0.36) + Math.sin(elapsed * 1.3) * fontSize * 0.012,
  }
}

function resolveSingleLyricWaveTiming(
  lines: LyricLine[],
  activeIndex: number,
  currentTime: number,
  useSpeedRamp: boolean,
): SingleLyricWaveTiming {
  const lineStart = lines[activeIndex]?.time ?? currentTime
  const elapsed = Math.max(0, currentTime - lineStart)
  const phaseOffset = activeIndex * 1.37

  if (!useSpeedRamp) {
    return {
      phase: elapsed * 2.1 + phaseOffset,
      intensity: 1,
    }
  }

  const decaySeconds = 0.32
  const fastAngularSpeed = 10.5
  const slowAngularSpeed = 1.35
  const decay = Math.exp(-elapsed / decaySeconds)
  const integratedPhase = slowAngularSpeed * elapsed
    + (fastAngularSpeed - slowAngularSpeed) * decaySeconds * (1 - decay)

  return {
    phase: phaseOffset + integratedPhase,
    intensity: 1.12 + Math.exp(-elapsed / 0.52) * 0.55,
  }
}

/**
 * A coherent, non-linear water motion for one complete lyric line. Rotation
 * around its center creates the gentle seesaw wave, while the scale pulse keeps
 * the body soft without breaking a line into per-glyph masks or slices.
 */
function resolveLyricLineWave(
  lineIndex: number,
  currentTime: number,
  fontSize: number,
  intensity: number,
  phaseOverride?: number,
): LyricLineWave {
  const phaseOffset = lineIndex * 1.37
  const phase = phaseOverride ?? currentTime * 2.1 + phaseOffset
  const longPhase = phaseOverride === undefined
    ? currentTime * 0.82 + lineIndex * 0.79
    : phase * 0.39 + lineIndex * 0.26
  const sway = Math.sin(phase) * 0.68 + Math.sin(longPhase + 0.86) * 0.24 + Math.sin(phase * 1.72 + 0.34) * 0.08
  const drift = Math.cos(phase * 0.74 + 0.72) * 0.7 + Math.sin(longPhase * 1.26) * 0.3
  const spring = Math.sin(phase - 0.5) * 0.72 + Math.sin(longPhase + 1.44) * 0.28

  return {
    translateX: drift * fontSize * 0.042 * intensity,
    translateY: sway * fontSize * 0.055 * intensity,
    rotation: sway * 0.014 * intensity,
    scaleX: 1 + spring * 0.012 * intensity,
    scaleY: 1 - spring * 0.008 * intensity,
  }
}

function applyLyricLineWave(
  ctx: VisualizerCanvasContext,
  wave: LyricLineWave,
  anchorX: number,
  anchorY: number,
): void {
  ctx.translate(wave.translateX, wave.translateY)
  ctx.translate(anchorX, anchorY)
  ctx.rotate(wave.rotation)
  ctx.scale(wave.scaleX, wave.scaleY)
  ctx.translate(-anchorX, -anchorY)
}

function buildPositionedLines(
  ctx: VisualizerCanvasContext,
  lines: LyricLine[],
  startIndex: number,
  endIndex: number,
  maxWidth: number,
  settings: VisualizerSettings,
): PositionedLine[] {
  const entries: PositionedLine[] = []
  const singleLineHeight = settings.fontSize * 1.2
  const baseCenterStep = Math.max(settings.lineGap, singleLineHeight * 1.08)
  let center = 0

  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines[index]
    const layout = getPreparedLine(ctx, line.text, maxWidth, settings)
    const previous = entries[entries.length - 1]

    if (previous) {
      const previousExtraHeight = Math.max(0, previous.layout.height - singleLineHeight)
      const currentExtraHeight = Math.max(0, layout.height - singleLineHeight)
      center += baseCenterStep + (previousExtraHeight + currentExtraHeight) / 2
    }

    entries.push({ index, line, layout, center })
  }

  return entries
}

function resolveCameraCenter(
  entries: PositionedLine[],
  lines: LyricLine[],
  activeIndex: number,
  currentTime: number,
): number {
  if (entries.length === 0) {
    return 0
  }

  const activeEntry = entries.find((entry) => entry.index === activeIndex)
  if (!activeEntry) {
    return entries[0].center
  }

  const historyStartIndex = Math.max(entries[0].index, activeIndex - 9)
  const historyStart = entries.find((entry) => entry.index === historyStartIndex) ?? entries[0]
  let camera = historyStart.center
  let previous = historyStart

  for (const entry of entries) {
    if (entry.index <= historyStart.index || entry.index > activeIndex) {
      continue
    }

    const lineInterval = entry.line.time - lines[entry.index - 1].time
    const response = resolveSpringResponse(currentTime - entry.line.time, lineInterval)
    camera += (entry.center - previous.center) * response
    previous = entry
  }

  return camera
}

function resolveLineTransitionProgress(lines: LyricLine[], activeIndex: number, currentTime: number): number {
  if (activeIndex <= 0) {
    return 1
  }

  const lineInterval = lines[activeIndex].time - lines[activeIndex - 1].time
  return resolveSpringResponse(currentTime - lines[activeIndex].time, lineInterval)
}

function resolveLyricFocusMotion(
  lines: LyricLine[],
  activeIndex: number,
  currentTime: number,
  fontSize: number,
): LyricFocusMotion {
  const lineStart = lines[activeIndex]?.time ?? currentTime
  const nextLineStart = lines[activeIndex + 1]?.time
  const lineDuration = nextLineStart === undefined ? 2 : Math.max(0.2, nextLineStart - lineStart)
  // Folia's active-line treatment arrives quickly, then settles. Keep the
  // duration relative to a short lyric line so this remains crisp at any BPM.
  const entranceDuration = Math.min(0.34, Math.max(0.18, lineDuration * 0.2))
  const rawProgress = clamp((currentTime - lineStart) / entranceDuration)
  const progress = 1 - Math.pow(1 - rawProgress, 3)
  const overshoot = Math.sin(progress * Math.PI) * 0.018

  return {
    alpha: 0.3 + progress * 0.7,
    blur: (1 - progress) * Math.min(7, Math.max(3.5, fontSize * 0.1)),
    scale: 0.94 + progress * 0.06 + overshoot,
    translateY: (1 - progress) * Math.min(22, fontSize * 0.32),
  }
}

function resolveSpringResponse(elapsed: number, lineInterval: number): number {
  if (elapsed <= 0) {
    return 0
  }

  if (lineInterval < 0.1) {
    return 1
  }

  // Same overdamped character as Folia's lyric rail (stiffness 142, damping 28, mass .82).
  // Evaluating it from the timeline keeps preview scrubbing and exported frames deterministic.
  const stiffness = lineInterval < 0.34 ? 178 : 142
  const damping = lineInterval < 0.34 ? 34 : 28
  const mass = 0.82
  const naturalFrequency = Math.sqrt(stiffness / mass)
  const dampingRatio = damping / (2 * Math.sqrt(stiffness * mass))

  if (dampingRatio <= 1) {
    const scaledTime = naturalFrequency * elapsed
    return clamp(1 - (1 + scaledTime) * Math.exp(-scaledTime))
  }

  const root = Math.sqrt(dampingRatio * dampingRatio - 1)
  const slowRate = naturalFrequency * (dampingRatio - root)
  const fastRate = naturalFrequency * (dampingRatio + root)
  const response = 1 - ((fastRate * Math.exp(-slowRate * elapsed)) - (slowRate * Math.exp(-fastRate * elapsed))) / (fastRate - slowRate)
  return clamp(response)
}

function resolveLineTone(
  index: number,
  focusIndex: number,
  activeIndex: number,
  transition: number,
  fastFadePastLines: boolean,
): LineTone {
  const offset = index - focusIndex

  if (activeIndex < 0) {
    if (offset === 0) {
      return { alpha: 0.9 }
    }

    if (offset > 0) {
      return { alpha: clamp(0.72 - (offset - 1) * 0.11) }
    }

    return { alpha: clamp(0.5 - (Math.abs(offset) - 1) * 0.1) }
  }

  if (offset === 0) {
    return {
      alpha: 0.72 + transition * 0.28,
    }
  }

  if (offset === -1) {
    const remainingFocus = 1 - transition

    if (fastFadePastLines) {
      const fadeProgress = smoothStep(clamp(transition * 1.35))
      return {
        alpha: (1 - fadeProgress) * 0.82,
      }
    }

    return {
      alpha: 0.46 + remainingFocus * 0.42,
    }
  }

  if (fastFadePastLines && offset < -1) {
    return { alpha: 0 }
  }

  const distance = Math.max(1, Math.abs(offset))
  const isFuture = offset > 0
  const alphaBase = isFuture ? 0.72 : 0.5

  return {
    alpha: clamp(alphaBase - (distance - 1) * (isFuture ? 0.12 : 0.1)),
  }
}

function resolveEdgeAlpha(
  y: number,
  halfHeight: number,
  topY: number,
  bottomY: number,
  topFadeRatio = 0.12,
  topFadePower = 1,
): number {
  const topFadeDistance = Math.max(22, (bottomY - topY) * topFadeRatio)
  const bottomFadeDistance = Math.max(36, (bottomY - topY) * 0.12)
  const topAlpha = clamp((y + halfHeight - topY) / topFadeDistance)
  const bottomAlpha = clamp((bottomY - (y - halfHeight)) / bottomFadeDistance)
  const shapedTopAlpha = Math.pow(smoothStep(topAlpha), topFadePower)
  return Math.min(shapedTopAlpha, smoothStep(bottomAlpha))
}

function getPreparedLine(
  ctx: VisualizerCanvasContext,
  text: string,
  maxWidth: number,
  settings: VisualizerSettings,
): PreparedLine {
  const cacheKey = [
    text,
    Math.round(maxWidth * 10) / 10,
    settings.fontSize,
    settings.chineseFont,
    settings.englishFont,
    lyricWeight,
  ].join('\u0001')
  const cached = lyricLayoutCache.get(cacheKey)

  if (cached) {
    lyricLayoutCache.delete(cacheKey)
    lyricLayoutCache.set(cacheKey, cached)
    return cached
  }

  const layout = prepareLineLayout(ctx, text, maxWidth, settings)

  if (lyricLayoutCache.size >= lyricLayoutCacheLimit) {
    const oldestKey = lyricLayoutCache.keys().next().value
    if (oldestKey) {
      lyricLayoutCache.delete(oldestKey)
    }
  }

  lyricLayoutCache.set(cacheKey, layout)
  return layout
}

function prepareLineLayout(
  ctx: VisualizerCanvasContext,
  text: string,
  maxWidth: number,
  settings: VisualizerSettings,
): PreparedLine {
  const graphemes = splitLyricGraphemes(text)
  const size = settings.fontSize
  const lineHeight = size * 1.2

  if (graphemes.length === 0) {
    return { rows: [], height: lineHeight, lineHeight, graphemeCount: 0 }
  }

  const widths = graphemes.map((grapheme) => measureText(
    ctx,
    grapheme,
    settings,
    size,
    lyricWeight,
  ))
  const rows: PreparedRow[] = []
  let rowStart = 0

  while (rowStart < graphemes.length) {
    while (rowStart < graphemes.length && isWhitespace(graphemes[rowStart])) {
      rowStart += 1
    }

    if (rowStart >= graphemes.length) {
      break
    }

    let rowEnd = rowStart
    let width = 0
    let preferredBreak = -1

    while (rowEnd < graphemes.length) {
      const nextWidth = widths[rowEnd]
      if (rowEnd > rowStart && width + nextWidth > maxWidth) {
        break
      }

      width += nextWidth
      if (isPreferredBreak(graphemes[rowEnd])) {
        preferredBreak = rowEnd + 1
      }
      rowEnd += 1
    }

    if (rowEnd < graphemes.length && preferredBreak > rowStart) {
      rowEnd = preferredBreak
    }

    let visibleEnd = rowEnd
    while (visibleEnd > rowStart && isWhitespace(graphemes[visibleEnd - 1])) {
      visibleEnd -= 1
    }

    if (visibleEnd <= rowStart) {
      rowStart = Math.max(rowEnd, rowStart + 1)
      continue
    }

    const rowText = graphemes.slice(rowStart, visibleEnd).join('')
    const segments = segmentText(rowText, settings, size, lyricWeight)
    const measuredWidth = measureSegments(ctx, segments)
    const rawAdvances = [0]
    let advance = 0

    for (let index = rowStart; index < visibleEnd; index += 1) {
      advance += widths[index]
      rawAdvances.push(advance)
    }

    const advanceScale = advance > 0 ? measuredWidth / advance : 1
    rows.push({
      segments,
      size,
      width: measuredWidth,
      startGrapheme: rowStart,
      endGrapheme: visibleEnd,
      graphemeAdvances: rawAdvances.map((value) => value * advanceScale),
      glyphs: graphemes.slice(rowStart, visibleEnd).map((grapheme, glyphIndex) => {
        const glyphWidth = (rawAdvances[glyphIndex + 1] ?? 0) - (rawAdvances[glyphIndex] ?? 0)
        const glyphSegments = segmentText(grapheme, settings, size, lyricWeight)

        return {
          text: grapheme,
          font: glyphSegments[0]?.font ?? `${Math.round(lyricWeight)} ${Math.round(size)}px ${defaultEnglishFont}`,
          width: glyphWidth * advanceScale,
        }
      }),
    })
    rowStart = Math.max(rowEnd, visibleEnd)
  }

  return {
    rows,
    height: Math.max(lineHeight, rows.length * lineHeight),
    lineHeight,
    graphemeCount: graphemes.length,
  }
}

function drawPreparedLine(
  ctx: VisualizerCanvasContext,
  layout: PreparedLine,
  x: number,
  y: number,
  align: CanvasTextAlign,
  color: string,
): void {
  const firstRowY = y - layout.height / 2 + layout.lineHeight / 2

  layout.rows.forEach((row, rowIndex) => {
    const rowX = getTextX(x, align, row.width)
    drawMixedTextWithMetrics(ctx, row, rowX, firstRowY + rowIndex * layout.lineHeight, color, false)
  })
}

/**
 * Draw complete graphemes along a shared wave baseline. Unlike the removed
 * slice effect, every character is painted once in full, then softly rotated
 * and stretched according to its position on the line-wide water wave.
 */
function drawGlyphWavePreparedLine(input: {
  ctx: VisualizerCanvasContext
  layout: PreparedLine
  x: number
  y: number
  align: CanvasTextAlign
  color: string
  phase: number
  intensity: number
}): void {
  const { ctx, layout, x, y, align, color, phase, intensity } = input
  const firstRowY = y - layout.height / 2 + layout.lineHeight / 2

  layout.rows.forEach((row, rowIndex) => {
    const rowX = getTextX(x, align, row.width)
    const rowY = firstRowY + rowIndex * layout.lineHeight
    const safeWidth = Math.max(1, row.width)

    row.glyphs.forEach((glyph, glyphIndex) => {
      if (!glyph.text.trim()) {
        return
      }

      const start = row.graphemeAdvances[glyphIndex] ?? 0
      const center = start + glyph.width / 2
      const position = center / safeWidth
      const localPhase = phase + position * Math.PI * 1.45 + rowIndex * 0.5
      const lift = Math.sin(localPhase) * 0.78 + Math.sin(localPhase * 0.56 + 0.8) * 0.22
      const tangent = Math.cos(localPhase) * 0.035 * intensity
      const verticalStretch = 1 + lift * 0.034 * intensity
      const horizontalStretch = 1 - lift * 0.012 * intensity

      ctx.save()
      ctx.translate(rowX + center, rowY + lift * row.size * 0.062 * intensity)
      ctx.rotate(tangent)
      ctx.scale(horizontalStretch, verticalStretch)
      ctx.font = glyph.font
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(glyph.text, 0, 0)
      ctx.restore()
    })
  })
}

function drawProgressPreparedLine(input: {
  ctx: VisualizerCanvasContext
  layout: PreparedLine
  x: number
  y: number
  align: CanvasTextAlign
  baseColor: string
  progressColor: string
  progress: number
}): void {
  const { ctx, layout } = input
  const firstRowY = input.y - layout.height / 2 + layout.lineHeight / 2
  const revealedGrapheme = clamp(input.progress) * layout.graphemeCount

  layout.rows.forEach((row, rowIndex) => {
    const rowX = getTextX(input.x, input.align, row.width)
    const rowY = firstRowY + rowIndex * layout.lineHeight
    const revealWidth = getRowRevealWidth(row, revealedGrapheme)

    drawMixedTextWithMetrics(ctx, row, rowX, rowY, input.baseColor, false)

    if (revealWidth <= 0) {
      return
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(rowX - 2, rowY - layout.lineHeight * 0.62, revealWidth + 4, layout.lineHeight * 1.24)
    ctx.clip()

    const inheritedAlpha = ctx.globalAlpha
    ctx.globalAlpha = inheritedAlpha * 0.34
    ctx.shadowColor = input.progressColor
    ctx.shadowBlur = Math.max(5, row.size * 0.1)
    drawMixedTextWithMetrics(ctx, row, rowX, rowY, input.progressColor, false)

    ctx.globalAlpha = inheritedAlpha
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    drawMixedTextWithMetrics(ctx, row, rowX, rowY, input.progressColor, false)
    ctx.restore()
  })
}

function getRowRevealWidth(row: PreparedRow, revealedGrapheme: number): number {
  const rowLength = row.endGrapheme - row.startGrapheme

  if (revealedGrapheme <= row.startGrapheme) {
    return 0
  }

  if (revealedGrapheme >= row.endGrapheme || rowLength <= 0) {
    return row.width
  }

  const localIndex = clampNumber(revealedGrapheme - row.startGrapheme, 0, rowLength)
  const wholeIndex = Math.floor(localIndex)
  const fraction = localIndex - wholeIndex
  const startAdvance = row.graphemeAdvances[wholeIndex] ?? 0
  const endAdvance = row.graphemeAdvances[wholeIndex + 1] ?? row.width
  return startAdvance + (endAdvance - startAdvance) * fraction
}

function drawBackground(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  coverImage?: CanvasImageSource,
  backgroundImage?: CanvasImageSource,
  currentTime = 0,
  renderScale = 1,
): void {
  if (settings.visualStyle === 'tiktok') {
    const panelHeight = Math.min(settings.width, settings.height)
    const panelTop = (settings.height - panelHeight) / 2
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, settings.width, settings.height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, panelTop, settings.width, panelHeight)
    return
  }

  if (settings.transparentBackground) {
    return
  }

  ctx.fillStyle = settings.backgroundColor
  ctx.fillRect(0, 0, settings.width, settings.height)

  if (backgroundImage) {
    drawCachedCustomBackground(ctx, settings, backgroundImage, renderScale)
    const darkness = clampNumber(settings.backgroundImageDarkness, 0, 100) / 100
    if (darkness > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${darkness.toFixed(3)})`
      ctx.fillRect(0, 0, settings.width, settings.height)
    }
  }

  if (settings.visualStyle === 'single') {
    drawSingleLyricAtmosphere(ctx, settings, backgroundImage ? undefined : coverImage, currentTime, renderScale)
    return
  }

  if (backgroundImage) {
    return
  }

  if (settings.visualStyle !== 'soda' || settings.height <= settings.width || !coverImage) {
    return
  }

  ctx.save()
  ctx.globalAlpha = 0.23
  ctx.filter = `blur(${Math.max(32, settings.width * 0.06)}px) saturate(1.25)`
  drawCoverImage(ctx, coverImage, -settings.width * 0.08, -settings.height * 0.08, settings.width * 1.16, settings.height * 1.16)
  ctx.filter = 'none'
  const shade = ctx.createLinearGradient(0, 0, 0, settings.height)
  shade.addColorStop(0, withAlpha(settings.backgroundColor, 0.14))
  shade.addColorStop(0.52, withAlpha(settings.backgroundColor, 0.58))
  shade.addColorStop(1, withAlpha(settings.backgroundColor, 0.9))
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, settings.width, settings.height)
  ctx.restore()
}

function drawCachedCustomBackground(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  image: CanvasImageSource,
  renderScale: number,
): void {
  const width = settings.width
  const height = settings.height
  const cacheWidth = Math.max(1, Math.round(width * renderScale))
  const cacheHeight = Math.max(1, Math.round(height * renderScale))
  const blur = clampNumber(settings.backgroundImageBlur, 0, 100)
  const cache = customBackgroundCache
  const isReusable = cache
    && cache.width === cacheWidth
    && cache.height === cacheHeight
    && cache.renderScale === renderScale
    && cache.blur === blur
    && cache.image === image

  if (!isReusable) {
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(cacheWidth, cacheHeight)
      : Object.assign(document.createElement('canvas'), { width: cacheWidth, height: cacheHeight })
    const cacheContext = canvas.getContext('2d') as VisualizerCanvasContext | null

    if (cacheContext) {
      cacheContext.setTransform(1, 0, 0, 1, 0, 0)
      cacheContext.clearRect(0, 0, cacheWidth, cacheHeight)
      cacheContext.setTransform(renderScale, 0, 0, renderScale, 0, 0)
      cacheContext.filter = blur > 0.01 ? `blur(${blur.toFixed(2)}px)` : 'none'
      const overscan = blur * 2.2
      drawCoverImage(
        cacheContext,
        image,
        -overscan,
        -overscan,
        width + overscan * 2,
        height + overscan * 2,
      )
      cacheContext.filter = 'none'
    }

    customBackgroundCache = {
      canvas,
      width: cacheWidth,
      height: cacheHeight,
      renderScale,
      blur,
      image,
    }
  }

  if (customBackgroundCache) {
    ctx.drawImage(customBackgroundCache.canvas, 0, 0, width, height)
  }
}

function drawSingleLyricAtmosphere(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  coverImage: CanvasImageSource | undefined,
  currentTime: number,
  renderScale: number,
): void {
  const width = settings.width
  const height = settings.height
  const pulse = Math.sin(currentTime * 0.42)

  if (coverImage) {
    drawCachedSingleCoverAtmosphere(ctx, settings, coverImage, renderScale)
  }

  ctx.save()
  const topGlow = ctx.createRadialGradient(
    width * (0.52 + Math.sin(currentTime * 0.22) * 0.06),
    height * (0.28 + Math.cos(currentTime * 0.19) * 0.04),
    0,
    width * 0.52,
    height * 0.34,
    Math.max(width, height) * 0.74,
  )
  topGlow.addColorStop(0, withAlpha(settings.progressColor, 0.18 + pulse * 0.025))
  topGlow.addColorStop(0.52, withAlpha(settings.lyricColor, 0.06))
  topGlow.addColorStop(1, withAlpha(settings.backgroundColor, 0))
  ctx.fillStyle = topGlow
  ctx.fillRect(0, 0, width, height)

  const lowerGlow = ctx.createRadialGradient(
    width * (0.38 + Math.cos(currentTime * 0.18) * 0.08),
    height * (0.71 + Math.sin(currentTime * 0.23) * 0.035),
    0,
    width * 0.38,
    height * 0.71,
    Math.max(width, height) * 0.55,
  )
  lowerGlow.addColorStop(0, withAlpha(settings.lyricColor, 0.1))
  lowerGlow.addColorStop(0.68, withAlpha(settings.nextColor, 0.035))
  lowerGlow.addColorStop(1, withAlpha(settings.backgroundColor, 0))
  ctx.fillStyle = lowerGlow
  ctx.fillRect(0, 0, width, height)

  const shade = ctx.createLinearGradient(0, 0, 0, height)
  shade.addColorStop(0, withAlpha(settings.backgroundColor, 0.22))
  shade.addColorStop(0.5, withAlpha(settings.backgroundColor, 0.42))
  shade.addColorStop(1, withAlpha(settings.backgroundColor, 0.7))
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

function drawCachedSingleCoverAtmosphere(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  coverImage: CanvasImageSource,
  renderScale: number,
): void {
  const width = settings.width
  const height = settings.height
  const cacheWidth = Math.max(1, Math.round(width * renderScale))
  const cacheHeight = Math.max(1, Math.round(height * renderScale))
  const cache = singleAtmosphereCoverCache
  const isReusable = cache
    && cache.width === cacheWidth
    && cache.height === cacheHeight
    && cache.renderScale === renderScale
    && cache.coverImage === coverImage

  if (!isReusable) {
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(cacheWidth, cacheHeight)
      : Object.assign(document.createElement('canvas'), { width: cacheWidth, height: cacheHeight })
    const cacheContext = canvas.getContext('2d') as VisualizerCanvasContext | null

    if (cacheContext) {
      cacheContext.setTransform(1, 0, 0, 1, 0, 0)
      cacheContext.clearRect(0, 0, cacheWidth, cacheHeight)
      cacheContext.setTransform(renderScale, 0, 0, renderScale, 0, 0)
      cacheContext.globalAlpha = 0.38
      cacheContext.filter = `blur(${Math.max(38, width * 0.075)}px) saturate(1.28)`
      drawCoverImage(cacheContext, coverImage, -width * 0.1, -height * 0.1, width * 1.2, height * 1.2)
      cacheContext.filter = 'none'
    }

    singleAtmosphereCoverCache = {
      canvas,
      width: cacheWidth,
      height: cacheHeight,
      renderScale,
      coverImage,
    }
  }

  if (singleAtmosphereCoverCache) {
    ctx.drawImage(singleAtmosphereCoverCache.canvas, 0, 0, width, height)
  }
}

function drawEmptyState(ctx: VisualizerCanvasContext, settings: VisualizerSettings): void {
  const isPortrait = settings.height > settings.width
  const align: CanvasTextAlign = settings.visualStyle === 'soda' || settings.lyricAlignment === 'left' ? 'left' : 'center'
  const x = align === 'left' ? settings.width * 0.075 : settings.width / 2
  const y = settings.height * (isPortrait ? 0.54 : 0.51)

  drawMixedText({
    ctx,
    text: '导入音频与 LRC 歌词',
    x,
    y,
    maxWidth: settings.width * (align === 'left' ? 0.85 : 0.84),
    size: settings.fontSize * 0.76,
    weight: 620,
    align,
    color: withAlpha(settings.nextColor, 0.64),
    settings,
  })
}

function drawSodaMetadata(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  title?: string,
  artist?: string,
  coverImage?: CanvasImageSource,
  brandIconImage?: CanvasImageSource,
  sodaBrandText?: string,
  sodaPlaylistText?: string,
): void {
  if (settings.height <= settings.width) {
    drawMetadata(ctx, settings, title, artist)
    return
  }

  const sodaUiSettings = getSodaUiSettings(settings)
  const brandX = settings.width * 0.06
  const brandY = settings.height * 0.18
  const brandIconSize = Math.max(42, settings.width * 0.053)
  const brandTextX = brandX + brandIconSize + settings.width * 0.016
  const brandTextValue = sodaBrandText?.trim() || '汽水音乐 · 抖音官方音乐App'
  const x = settings.width * 0.06
  const y = settings.height * 0.215
  const width = settings.width * 0.88
  const height = settings.height * 0.24
  const coverSize = Math.min(height * 0.55, settings.width * 0.245)
  const coverX = x + settings.width * 0.033
  const coverY = y + height * 0.08
  const textX = coverX + coverSize + settings.width * 0.04
  const textWidth = x + width - textX - settings.width * 0.043

  drawSodaBrandIcon(ctx, settings, brandIconImage, brandX, brandY - brandIconSize / 2, brandIconSize)
  drawMixedText({
    ctx,
    text: brandTextValue,
    x: brandTextX,
    y: brandY,
    maxWidth: settings.width * 0.78 - brandIconSize,
    size: settings.sodaBrandFontSize,
    weight: 680,
    align: 'left',
    color: withAlpha(settings.metaColor, 0.98),
    settings: sodaUiSettings,
  })

  ctx.save()
  ctx.fillStyle = withAlpha(settings.metaColor, 0.14)
  roundRect(ctx, x, y, width, height, Math.min(38, settings.width * 0.04))
  ctx.fill()
  ctx.globalAlpha = 0.16
  ctx.strokeStyle = settings.metaColor
  ctx.lineWidth = Math.max(1, settings.width * 0.0013)
  roundRect(ctx, x, y, width, height, Math.min(38, settings.width * 0.04))
  ctx.stroke()
  ctx.restore()

  drawCoverTile(ctx, settings, coverImage, coverX, coverY, coverSize)

  drawMixedText({
    ctx,
    text: title || '未命名作品',
    x: textX,
    y: y + height * 0.31,
    maxWidth: textWidth,
    size: settings.metadataTitleFontSize,
    weight: 620,
    align: 'left',
    color: withAlpha(settings.metaColor, 0.98),
    settings: sodaUiSettings,
  })

  drawMixedText({
    ctx,
    text: artist || '未知歌手',
    x: textX,
    y: y + height * 0.52,
    maxWidth: textWidth,
    size: settings.metadataArtistFontSize,
    weight: 500,
    align: 'left',
    color: withAlpha(settings.metaColor, 0.7),
    settings: sodaUiSettings,
  })

  ctx.save()
  ctx.globalAlpha = 0.25
  ctx.strokeStyle = settings.metaColor
  ctx.lineWidth = Math.max(1, settings.width * 0.001)
  ctx.beginPath()
  ctx.moveTo(x + settings.width * 0.035, y + height * 0.7)
  ctx.lineTo(x + width - settings.width * 0.035, y + height * 0.7)
  ctx.stroke()
  ctx.restore()

  const playlistX = x + settings.width * 0.04
  const playlistY = y + height * 0.87
  drawSodaEqualizer(ctx, settings, playlistX, playlistY, settings.width * 0.03)
  drawMixedText({
    ctx,
    text: sodaPlaylistText?.trim() || '查看我的今日歌单',
    x: playlistX + settings.width * 0.052,
    y: playlistY,
    maxWidth: width - settings.width * 0.15,
    size: settings.sodaPlaylistFontSize,
    weight: 620,
    align: 'left',
    color: withAlpha(settings.metaColor, 0.98),
    settings: sodaUiSettings,
  })

  ctx.save()
  ctx.fillStyle = withAlpha(settings.metaColor, 0.98)
  ctx.font = `${Math.round(Math.max(34, settings.sodaPlaylistFontSize * 1.25))}px ${sodaUiEnglishFont}`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillText('›', x + width - settings.width * 0.04, playlistY)
  ctx.restore()
}

function getSodaUiSettings(settings: VisualizerSettings): VisualizerSettings {
  return {
    ...settings,
    chineseFont: sodaUiChineseFont,
    englishFont: sodaUiEnglishFont,
  }
}

function drawSodaMusicMark(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save()
  ctx.fillStyle = 'rgba(10, 10, 12, 0.92)'
  roundRect(ctx, x, y, size, size, Math.max(9, size * 0.18))
  ctx.fill()
  ctx.fillStyle = settings.progressColor
  ctx.font = `${Math.round(size * 0.62)}px ${sodaUiEnglishFont}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('♪', x + size * 0.5, y + size * 0.53)
  ctx.restore()
}

function drawSodaBrandIcon(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  brandIconImage: CanvasImageSource | undefined,
  x: number,
  y: number,
  size: number,
): void {
  if (!brandIconImage) {
    drawSodaMusicMark(ctx, settings, x, y, size)
    return
  }

  ctx.save()
  roundRect(ctx, x, y, size, size, Math.max(9, size * 0.18))
  ctx.clip()
  drawCoverImage(ctx, brandIconImage, x, y, size, size)
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = 0.28
  ctx.strokeStyle = settings.metaColor
  ctx.lineWidth = Math.max(1, size * 0.035)
  roundRect(ctx, x, y, size, size, Math.max(9, size * 0.18))
  ctx.stroke()
  ctx.restore()
}

function drawSodaEqualizer(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  x: number,
  y: number,
  width: number,
): void {
  const barWidth = Math.max(3, width * 0.14)
  const gap = barWidth * 0.8
  const heights = [0.42, 0.76, 0.58]

  ctx.save()
  ctx.fillStyle = withAlpha(settings.metaColor, 0.98)
  heights.forEach((heightRatio, index) => {
    const height = width * heightRatio
    const barX = x + index * (barWidth + gap)
    roundRect(ctx, barX, y - height / 2, barWidth, height, barWidth / 2)
    ctx.fill()
  })
  ctx.restore()
}

function drawCoverTile(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  coverImage: CanvasImageSource | undefined,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save()
  roundRect(ctx, x, y, size, size, Math.max(12, size * 0.12))
  ctx.clip()

  if (coverImage) {
    drawCoverImage(ctx, coverImage, x, y, size, size)
  } else {
    const placeholder = ctx.createLinearGradient(x, y, x + size, y + size)
    placeholder.addColorStop(0, withAlpha(settings.progressColor, 0.92))
    placeholder.addColorStop(0.54, withAlpha(settings.lyricColor, 0.8))
    placeholder.addColorStop(1, withAlpha(settings.backgroundColor, 0.94))
    ctx.fillStyle = placeholder
    ctx.fillRect(x, y, size, size)
    ctx.globalAlpha = 0.76
    ctx.fillStyle = settings.metaColor
    ctx.font = `${Math.round(size * 0.36)}px ${settings.englishFont || defaultEnglishFont}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('♪', x + size / 2, y + size / 2)
  }

  ctx.restore()
}

function drawCoverImage(
  ctx: VisualizerCanvasContext,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const source = getImageSize(image)
  if (source.width <= 0 || source.height <= 0) {
    return
  }

  const scale = Math.max(width / source.width, height / source.height)
  const drawWidth = source.width * scale
  const drawHeight = source.height * scale
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

function getImageSize(image: CanvasImageSource): { width: number; height: number } {
  if ('videoWidth' in image) {
    return { width: image.videoWidth, height: image.videoHeight }
  }

  if ('naturalWidth' in image) {
    return { width: image.naturalWidth, height: image.naturalHeight }
  }

  const sizedImage = image as { width?: number; height?: number; displayWidth?: number; displayHeight?: number }
  return {
    width: sizedImage.width ?? sizedImage.displayWidth ?? 0,
    height: sizedImage.height ?? sizedImage.displayHeight ?? 0,
  }
}

function drawMetadata(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  title?: string,
  artist?: string,
): void {
  if (!title && !artist) {
    return
  }

  const isPortrait = settings.height > settings.width
  const x = settings.width * (isPortrait ? 0.075 : 0.06)
  const maxWidth = settings.width * (isPortrait ? 0.82 : 0.72)

  if (title) {
    drawMixedText({
      ctx,
      text: title,
      x,
      y: settings.height * (isPortrait ? 0.105 : 0.09),
      maxWidth,
      size: settings.metadataTitleFontSize,
      weight: 680,
      align: 'left',
      color: withAlpha(settings.metaColor, 0.92),
      settings,
    })
  }

  if (artist) {
    drawMixedText({
      ctx,
      text: artist,
      x,
      y: settings.height * (isPortrait ? 0.158 : 0.14),
      maxWidth,
      size: settings.metadataArtistFontSize,
      weight: 500,
      align: 'left',
      color: withAlpha(settings.metaColor, 0.62),
      settings,
    })
  }
}

function drawProgressBar(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  currentTime: number,
  duration: number,
): void {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1
  const progress = clamp(currentTime / safeDuration)
  const isPortrait = settings.height > settings.width
  const width = settings.width * (isPortrait ? 0.85 : 0.72)
  const height = Math.max(4, settings.height * 0.0045)
  const x = isPortrait ? settings.width * 0.075 : (settings.width - width) / 2
  const y = settings.height * 0.89

  ctx.save()
  ctx.globalAlpha = 0.25
  ctx.fillStyle = settings.nextColor
  roundRect(ctx, x, y, width, height, height / 2)
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.fillStyle = settings.progressColor
  roundRect(ctx, x, y, width * progress, height, height / 2)
  ctx.fill()
  ctx.restore()
}

function drawBeatReactiveBar(
  ctx: VisualizerCanvasContext,
  settings: VisualizerSettings,
  currentTime: number,
  beatStrength: number,
): void {
  const isPortrait = settings.height > settings.width
  const width = settings.width * (isPortrait ? 0.72 : 0.58)
  const centerX = settings.width / 2
  const centerY = settings.height * (isPortrait ? 0.945 : 0.925)
  const barCount = isPortrait ? 44 : 54
  const step = width / Math.max(1, barCount - 1)
  const barWidth = Math.max(2.2, settings.width * 0.0032)
  const baseHeight = Math.max(3, settings.height * 0.0022)
  const maximumHeight = settings.height * (isPortrait ? 0.034 : 0.065)
  const energy = Math.pow(clamp(beatStrength), 0.82)

  ctx.save()
  ctx.fillStyle = withAlpha(settings.progressColor, 0.82)
  ctx.globalAlpha = 0.32 + energy * 0.58
  ctx.shadowColor = withAlpha(settings.progressColor, 0.56)
  ctx.shadowBlur = energy * Math.max(5, settings.width * 0.012)

  for (let index = 0; index < barCount; index += 1) {
    const position = index / Math.max(1, barCount - 1)
    const centeredPosition = position * 2 - 1
    const ripple = 0.5 + Math.sin(currentTime * 5.6 - Math.abs(centeredPosition) * 8.4) * 0.5
    const echo = 0.5 + Math.sin(currentTime * 3.7 + centeredPosition * 5.2 + 1.2) * 0.5
    const centerWeight = 1 - Math.abs(centeredPosition) * 0.24
    const localResponse = (0.32 + ripple * 0.48 + echo * 0.2) * centerWeight
    const height = baseHeight + maximumHeight * energy * localResponse
    const x = centerX - width / 2 + index * step - barWidth / 2

    roundRect(ctx, x, centerY - height / 2, barWidth, height, barWidth / 2)
    ctx.fill()
  }

  ctx.restore()
}

function drawMixedText(input: {
  ctx: VisualizerCanvasContext
  text: string
  x: number
  y: number
  maxWidth: number
  size: number
  weight: number
  align: CanvasTextAlign
  color: string
  settings: VisualizerSettings
}): void {
  const metrics = prepareTextMetrics(input)
  const textX = getTextX(input.x, input.align, metrics.width)
  drawMixedTextWithMetrics(input.ctx, metrics, textX, input.y, input.color)
}

function prepareTextMetrics(input: {
  ctx: VisualizerCanvasContext
  text: string
  maxWidth: number
  size: number
  weight: number
  settings: VisualizerSettings
}): PreparedText {
  let size = input.size
  let segments = segmentText(input.text, input.settings, size, input.weight)
  let width = measureSegments(input.ctx, segments)

  while (width > input.maxWidth && size > 18) {
    size *= 0.94
    segments = segmentText(input.text, input.settings, size, input.weight)
    width = measureSegments(input.ctx, segments)
  }

  return { segments, size, width }
}

function drawMixedTextWithMetrics(
  ctx: VisualizerCanvasContext,
  metrics: PreparedText,
  x: number,
  y: number,
  color: string,
  useBodyShadow = true,
): void {
  let cursorX = x

  ctx.save()
  ctx.textBaseline = 'middle'
  if (useBodyShadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.08)'
    ctx.shadowBlur = Math.max(2, metrics.size * 0.025)
    ctx.shadowOffsetY = Math.max(1, metrics.size * 0.01)
  }
  ctx.fillStyle = color

  for (const segment of metrics.segments) {
    ctx.font = segment.font
    ctx.fillText(segment.text, cursorX, y)
    cursorX += segment.width ?? ctx.measureText(segment.text).width
  }

  ctx.restore()
}

function segmentText(text: string, settings: VisualizerSettings, size: number, weight: number): TextSegment[] {
  const segments: TextSegment[] = []
  let current = ''
  let currentFont = ''

  for (const char of Array.from(text)) {
    const fontFamily = isCjk(char) ? settings.chineseFont || defaultChineseFont : settings.englishFont || defaultEnglishFont
    const font = `${Math.round(weight)} ${Math.round(size)}px ${fontFamily}`

    if (font !== currentFont && current.length > 0) {
      segments.push({ text: current, font: currentFont })
      current = ''
    }

    current += char
    currentFont = font
  }

  if (current.length > 0) {
    segments.push({ text: current, font: currentFont })
  }

  return segments
}

function measureText(
  ctx: VisualizerCanvasContext,
  text: string,
  settings: VisualizerSettings,
  size: number,
  weight: number,
): number {
  return measureSegments(ctx, segmentText(text, settings, size, weight))
}

function measureSegments(ctx: VisualizerCanvasContext, segments: TextSegment[]): number {
  return segments.reduce((width, segment) => {
    ctx.font = segment.font
    const measuredWidth = ctx.measureText(segment.text).width
    segment.width = measuredWidth
    return width + measuredWidth
  }, 0)
}

function getTextX(anchorX: number, align: CanvasTextAlign, textWidth: number): number {
  if (align === 'center') {
    return anchorX - textWidth / 2
  }

  if (align === 'right' || align === 'end') {
    return anchorX - textWidth
  }

  return anchorX
}

function roundRect(ctx: VisualizerCanvasContext, x: number, y: number, width: number, height: number, radius: number): void {
  const safeRadius = Math.min(radius, width / 2, height / 2)

  ctx.beginPath()
  ctx.moveTo(x + safeRadius, y)
  ctx.lineTo(x + width - safeRadius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  ctx.lineTo(x + width, y + height - safeRadius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  ctx.lineTo(x + safeRadius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  ctx.lineTo(x, y + safeRadius)
  ctx.quadraticCurveTo(x, y, x + safeRadius, y)
  ctx.closePath()
}

function isCjk(char: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(char)
}

function isWhitespace(char: string): boolean {
  return /^\s+$/u.test(char)
}

function isPreferredBreak(char: string): boolean {
  return isWhitespace(char) || isCjk(char) || /[，。！？、；：,.!?;:）)】\]}]/u.test(char)
}

function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#')) {
    return color
  }

  const normalized = color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color
  const numeric = Number.parseInt(normalized.slice(1), 16)
  const red = (numeric >> 16) & 255
  const green = (numeric >> 8) & 255
  const blue = numeric & 255

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function smoothStep(value: number): number {
  const safeValue = clamp(value)
  return safeValue * safeValue * (3 - 2 * safeValue)
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
