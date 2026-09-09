import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  fastExportVisualizer,
  getDirectExportSupport,
  type FastExportSupport,
} from './fast-export.ts'
import { alignLyricsToAudio } from './audio-word-alignment.ts'
import {
  decodeLrcFile,
  parseLrc,
  parsePlainTextLyrics,
  type LyricLine,
  type ParsedLrc,
} from './lrc.ts'
import {
  extractImagePalette,
  palettePresets,
  type VisualizerPalette,
} from './palette.ts'
import { readAudioMetadata } from './audio-metadata.ts'
import {
  analyzeAudioFile,
  sampleAudioReactiveEnvelope,
  type AudioReactiveEnvelope,
} from './audio-reactivity.ts'
import {
  drawVisualizer,
  fitCanvasToSettings,
  getTikTokWordFrameTimeline,
  type VisualizerSettings,
} from './renderer.ts'
import { TimingEditor, type TimingDraftLine } from './TimingEditor.tsx'
import {
  exportTikTokWordFrames,
  type TikTokFrameExportResult,
} from './tiktok-frame-export.ts'
import {
  getInitialUiLanguage,
  localizeErrorMessage,
  pickUiText,
  type UiLanguage,
} from './ui-language.ts'

interface ImportedFont {
  id: string
  name: string
  family: string
  url: string
}

interface ExportResult {
  url: string
  filename: string
  mimeType: string
}

interface PresetSize {
  label: string
  width: number
  height: number
}

interface TimingEditorSource {
  name: string
  encoding: string
  metadata: Record<string, string>
  lines: TimingDraftLine[]
}

const chineseSystemFont = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const englishSystemFont = 'Inter, "SF Pro Display", Arial, sans-serif'
const tiktokReferenceFont = '"Arial Narrow", "Helvetica Neue", Arial, sans-serif'

const presetSizes: PresetSize[] = [
  { label: '16:9 1920 x 1080', width: 1920, height: 1080 },
  { label: '9:16 1080 x 1920', width: 1080, height: 1920 },
  { label: '1:1 1080 x 1080', width: 1080, height: 1080 },
]

const fallbackLrc = parseLrc(`[ti:METRONOME]
[ar:LRC Visualizer Preview]
[00:00.00]让歌词自然地沿画面滚动
[00:02.80]中文、English 与混合排版
[00:05.40]Current lyric moves with the music
[00:08.20]正在播放的歌词只微微放大
[00:11.00]变色从左到右完整覆盖
[00:13.80]You can tune every color
[00:16.40]显示更多上下文歌词
[00:19.00]字体和行距也可以调整
[00:21.60]导出属于你的歌词视频
[00:24.20]Ready when you are
`)

type ExportRangeMode = 'full' | 'selection'
type TextElement = 'currentLyric' | 'normalLyric' | 'title' | 'artist' | 'brand' | 'playlist'

const minimumExportDuration = 0.1
const defaultPalette = palettePresets[0]

function App() {
  const [language, setLanguage] = useState<UiLanguage>(getInitialUiLanguage)
  const ui = useCallback((chinese: string, english: string) => (
    pickUiText(language, chinese, english)
  ), [language])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const canvasShellRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const seekSliderRef = useRef<HTMLInputElement | null>(null)
  const currentTimeValueRef = useRef<HTMLSpanElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const audioFileRef = useRef<File | null>(null)
  const resultUrlRef = useRef<string | null>(null)
  const frameSequenceUrlRef = useRef<string | null>(null)
  const paletteImageUrlRef = useRef<string | null>(null)
  const coverUrlRef = useRef<string | null>(null)
  const coverImageRef = useRef<HTMLImageElement | null>(null)
  const backgroundImageUrlRef = useRef<string | null>(null)
  const backgroundImageRef = useRef<HTMLImageElement | null>(null)
  const brandIconUrlRef = useRef<string | null>(null)
  const brandIconImageRef = useRef<HTMLImageElement | null>(null)
  const importedFontsRef = useRef<ImportedFont[]>([])
  const audioReactiveEnvelopeRef = useRef<AudioReactiveEnvelope | null>(null)
  const currentTimeRef = useRef(0)
  const isScrubbingRef = useRef(false)
  const resumeAfterScrubRef = useRef(false)
  const [audioFileName, setAudioFileName] = useState('')
  const [audioUrl, setAudioUrl] = useState('')
  const [audioDuration, setAudioDuration] = useState(27)
  const [parsedLrc, setParsedLrc] = useState<ParsedLrc>(fallbackLrc)
  const [lrcFileName, setLrcFileName] = useState('')
  const [lrcEncoding, setLrcEncoding] = useState('')
  const [fontStatus, setFontStatus] = useState(() => pickUiText(language, '未导入字体', 'No font imported'))
  const [importedFonts, setImportedFonts] = useState<ImportedFont[]>([])
  const [settings, setSettings] = useState<VisualizerSettings>({
    width: 1080,
    height: 1920,
    backgroundColor: defaultPalette.backgroundColor,
    transparentBackground: false,
    backgroundImageBlur: 24,
    backgroundImageDarkness: 38,
    lyricColor: defaultPalette.lyricColor,
    progressColor: defaultPalette.progressColor,
    lyricHighlightMode: 'animated',
    nextColor: defaultPalette.nextColor,
    metaColor: defaultPalette.metaColor,
    chineseFont: chineseSystemFont,
    englishFont: englishSystemFont,
    fontSize: 68,
    metadataTitleFontSize: 44,
    metadataArtistFontSize: 30,
    sodaBrandFontSize: 45,
    sodaPlaylistFontSize: 39,
    lineGap: 112,
    visibleLineCount: 9,
    lyricAlignment: 'center',
    visualStyle: 'classic',
    tiktokTextBlur: 2,
    singleWaveSpeedRamp: false,
    showBeatBar: false,
    showMetadata: true,
    showProgressBar: false,
  })
  const [isPlaying, setIsPlaying] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportCurrentTime, setExportCurrentTime] = useState(0)
  const [exportStatus, setExportStatus] = useState(() => pickUiText(language, '等待导出', 'Ready to export'))
  const [isExporting, setIsExporting] = useState(false)
  const [exportRangeMode, setExportRangeMode] = useState<ExportRangeMode>('full')
  const [exportStartTime, setExportStartTime] = useState(0)
  const [exportEndTime, setExportEndTime] = useState(27)
  const [fastExportSupport, setFastExportSupport] = useState<FastExportSupport | null>(null)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [frameSequenceResult, setFrameSequenceResult] = useState<TikTokFrameExportResult | null>(null)
  const [paletteImageUrl, setPaletteImageUrl] = useState('')
  const [paletteSourceName, setPaletteSourceName] = useState('')
  const [paletteStatus, setPaletteStatus] = useState(() => pickUiText(language, '上传画面截图，自动生成协调的歌词颜色', 'Upload a reference image to generate a coordinated lyric palette'))
  const [paletteSwatches, setPaletteSwatches] = useState([
    defaultPalette.backgroundColor,
    defaultPalette.progressColor,
    defaultPalette.lyricColor,
    defaultPalette.nextColor,
    defaultPalette.metaColor,
  ])
  const [activePaletteId, setActivePaletteId] = useState(defaultPalette.id)
  const [songTitle, setSongTitle] = useState(fallbackLrc.metadata.ti || fallbackLrc.metadata.title || '')
  const [songArtist, setSongArtist] = useState(fallbackLrc.metadata.ar || fallbackLrc.metadata.artist || '')
  const [coverUrl, setCoverUrl] = useState('')
  const [coverName, setCoverName] = useState('')
  const [coverRenderVersion, setCoverRenderVersion] = useState(0)
  const [backgroundImageUrl, setBackgroundImageUrl] = useState('')
  const [backgroundImageName, setBackgroundImageName] = useState('')
  const [backgroundImageSize, setBackgroundImageSize] = useState<{ width: number; height: number } | null>(null)
  const [backgroundImageRenderVersion, setBackgroundImageRenderVersion] = useState(0)
  const [brandIconUrl, setBrandIconUrl] = useState('')
  const [brandIconName, setBrandIconName] = useState('')
  const [brandIconRenderVersion, setBrandIconRenderVersion] = useState(0)
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false)
  const [activeStyleTab, setActiveStyleTab] = useState<'scene' | 'lyrics' | 'typeMotion'>('lyrics')
  const [activeTextElement, setActiveTextElement] = useState<TextElement>('currentLyric')
  const [saveStatus, setSaveStatus] = useState(() => pickUiText(language, '正在保存', 'Saving'))
  const [isPromoExpanded, setIsPromoExpanded] = useState(false)
  const [sodaBrandText, setSodaBrandText] = useState('汽水音乐 · 抖音官方音乐App')
  const [sodaPlaylistText, setSodaPlaylistText] = useState('查看我的今日歌单')
  const [previewCanvasSize, setPreviewCanvasSize] = useState({ width: 0, height: 0 })
  const [audioAnalysisVersion, setAudioAnalysisVersion] = useState(0)
  const [beatAnalysisStatus, setBeatAnalysisStatus] = useState(() => pickUiText(language, '导入音频后分析低频鼓点', 'Import audio to analyze low-frequency beats'))
  const [timingEditorSource, setTimingEditorSource] = useState<TimingEditorSource | null>(null)
  const [isPasteLyricsOpen, setIsPasteLyricsOpen] = useState(false)
  const [pastedLyricsText, setPastedLyricsText] = useState('')
  const [pasteLyricsError, setPasteLyricsError] = useState('')
  const [isAligningLyrics, setIsAligningLyrics] = useState(false)

  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN'
    try {
      window.localStorage.setItem('lrc-visualizer-language', language)
    } catch {
      // Language persistence is optional when storage is unavailable.
    }
  }, [language])

  useEffect(() => {
    setSaveStatus(pickUiText(language, '实时预览', 'Live preview'))
    setExportStatus(isExporting
      ? pickUiText(language, `正在导出 ${Math.round(exportProgress * 100)}%`, `Exporting ${Math.round(exportProgress * 100)}%`)
      : pickUiText(language, '等待导出', 'Ready to export'))
    setPaletteStatus(paletteSourceName
      ? pickUiText(language, `已从 ${paletteSourceName} 生成配色`, `Palette generated from ${paletteSourceName}`)
      : pickUiText(language, '上传画面截图，自动生成协调的歌词颜色', 'Upload a reference image to generate a coordinated lyric palette'))
    setFontStatus(importedFontsRef.current.length > 0
      ? pickUiText(language, `已导入：${importedFontsRef.current.at(-1)?.name ?? ''}`, `Imported: ${importedFontsRef.current.at(-1)?.name ?? ''}`)
      : pickUiText(language, '未导入字体', 'No font imported'))
    setBeatAnalysisStatus(audioUrlRef.current
      ? pickUiText(language, '鼓点分析状态与当前音频保持同步', 'Beat analysis stays synchronized with the current audio')
      : pickUiText(language, '导入音频后分析低频鼓点', 'Import audio to analyze low-frequency beats'))
    setPasteLyricsError((current) => current
      ? pickUiText(language, '请至少粘贴一行歌词。', 'Paste at least one lyric line.')
      : '')
  }, [language])

  const title = songTitle.trim() || parsedLrc.metadata.ti || parsedLrc.metadata.title || stripExtension(lrcFileName || audioFileName)
  const artist = songArtist.trim() || parsedLrc.metadata.ar || parsedLrc.metadata.artist || ''
  const fontOptions = useMemo(
    () => [
      { label: ui('系统中文', 'System Chinese'), value: chineseSystemFont },
      { label: ui('系统英文', 'System English'), value: englishSystemFont },
      { label: ui('Arial Narrow（TikTok 参考）', 'Arial Narrow (TikTok reference)'), value: tiktokReferenceFont },
      ...importedFonts.map((font) => ({ label: font.name, value: quoteFontFamily(font.family) })),
    ],
    [importedFonts, ui],
  )
  const activeTextElementLabel = {
    currentLyric: ui('当前歌词', 'Current lyric'),
    normalLyric: ui('普通歌词', 'Inactive lyrics'),
    title: ui('歌名', 'Song title'),
    artist: ui('歌手', 'Artist'),
    brand: ui('顶部宣传栏', 'Top banner'),
    playlist: ui('歌单入口', 'Playlist link'),
  }[activeTextElement]
  const activeTextSize = resolveTextElementSize(settings, activeTextElement)
  const activeTextColor = resolveTextElementColor(settings, activeTextElement)
  const backgroundFitDescription = backgroundImageSize
    ? `${backgroundImageSize.width}×${backgroundImageSize.height} · ${isMatchingAspectRatio(backgroundImageSize, settings)
      ? ui(`匹配当前 ${formatAspectRatio(settings.width, settings.height)} 画幅`, `Matches the current ${formatAspectRatio(settings.width, settings.height)} canvas`)
      : ui(`将自动居中裁切为 ${formatAspectRatio(settings.width, settings.height)}`, `Will be center-cropped to ${formatAspectRatio(settings.width, settings.height)}`)}`
    : ui('建议上传与输出画幅相同比例的图片；其他比例会自动居中裁切', 'Use an image matching the output ratio when possible; other ratios are center-cropped automatically')

  const renderFrame = useCallback((time = currentTimeRef.current) => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const renderScale = getPreviewRenderScale(settings)
    fitCanvasToSettings(canvas, settings, renderScale)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    drawVisualizer({
      ctx,
      lines: parsedLrc.lines,
      currentTime: time,
      duration: audioDuration,
      settings,
      title,
      artist,
      coverImage: coverImageRef.current ?? undefined,
      backgroundImage: backgroundImageRef.current ?? undefined,
      brandIconImage: brandIconImageRef.current ?? undefined,
      sodaBrandText,
      sodaPlaylistText,
      beatStrength: settings.showBeatBar
        ? sampleAudioReactiveEnvelope(audioReactiveEnvelopeRef.current, time)
        : 0,
      renderScale,
    })
  }, [artist, audioAnalysisVersion, audioDuration, backgroundImageRenderVersion, brandIconRenderVersion, coverRenderVersion, parsedLrc.lines, settings, sodaBrandText, sodaPlaylistText, title])

  useEffect(() => {
    try {
      const savedDraft = window.localStorage.getItem('lrc-visualizer-draft')
      if (!savedDraft) {
        return
      }

      const draft = JSON.parse(savedDraft) as Partial<{
        settings: Partial<VisualizerSettings>
        songTitle: string
        songArtist: string
        sodaBrandText: string
        sodaPlaylistText: string
      }>
      if (draft.settings && typeof draft.settings === 'object') {
        setSettings((current) => ({ ...current, ...draft.settings }))
      }
      if (typeof draft.songTitle === 'string') setSongTitle(draft.songTitle)
      if (typeof draft.songArtist === 'string') setSongArtist(draft.songArtist)
      if (typeof draft.sodaBrandText === 'string') setSodaBrandText(draft.sodaBrandText)
      if (typeof draft.sodaPlaylistText === 'string') setSodaPlaylistText(draft.sodaPlaylistText)
      setSaveStatus(pickUiText(language, '已恢复上次编辑', 'Previous edit restored'))
    } catch {
      setSaveStatus(pickUiText(language, '实时预览', 'Live preview'))
    }
  }, [])

  useEffect(() => {
    renderFrame(currentTimeRef.current)
  }, [renderFrame])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem('lrc-visualizer-draft', JSON.stringify({
          settings,
          songTitle,
          songArtist,
          sodaBrandText,
          sodaPlaylistText,
        }))
        setSaveStatus(ui('已自动保存', 'Autosaved'))
      } catch {
        setSaveStatus(ui('实时预览', 'Live preview'))
      }
    }, 420)

    return () => window.clearTimeout(timer)
  }, [settings, sodaBrandText, sodaPlaylistText, songArtist, songTitle, ui])

  useEffect(() => {
    if (!coverUrl) {
      coverImageRef.current = null
      setCoverRenderVersion((version) => version + 1)
      return undefined
    }

    const image = new Image()
    image.onload = () => {
      coverImageRef.current = image
      setCoverRenderVersion((version) => version + 1)
    }
    image.onerror = () => {
      coverImageRef.current = null
      setCoverRenderVersion((version) => version + 1)
    }
    image.src = coverUrl

    return () => {
      image.onload = null
      image.onerror = null
    }
  }, [coverUrl])

  useEffect(() => {
    if (!backgroundImageUrl) {
      backgroundImageRef.current = null
      setBackgroundImageSize(null)
      setBackgroundImageRenderVersion((version) => version + 1)
      return undefined
    }

    const image = new Image()
    image.onload = () => {
      backgroundImageRef.current = image
      setBackgroundImageSize({ width: image.naturalWidth, height: image.naturalHeight })
      setBackgroundImageRenderVersion((version) => version + 1)
    }
    image.onerror = () => {
      backgroundImageRef.current = null
      setBackgroundImageSize(null)
      setBackgroundImageRenderVersion((version) => version + 1)
    }
    image.src = backgroundImageUrl

    return () => {
      image.onload = null
      image.onerror = null
    }
  }, [backgroundImageUrl])

  useEffect(() => {
    if (!brandIconUrl) {
      brandIconImageRef.current = null
      setBrandIconRenderVersion((version) => version + 1)
      return undefined
    }

    const image = new Image()
    image.onload = () => {
      brandIconImageRef.current = image
      setBrandIconRenderVersion((version) => version + 1)
    }
    image.onerror = () => {
      brandIconImageRef.current = null
      setBrandIconRenderVersion((version) => version + 1)
    }
    image.src = brandIconUrl

    return () => {
      image.onload = null
      image.onerror = null
    }
  }, [brandIconUrl])

  useEffect(() => {
    let isCancelled = false

    setFastExportSupport(null)
    void getDirectExportSupport(settings).then((support) => {
      if (!isCancelled) {
        setFastExportSupport(support)
      }
    })

    return () => {
      isCancelled = true
    }
  }, [settings.height, settings.transparentBackground, settings.width])

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsPreviewFullscreen(document.fullscreenElement === canvasShellRef.current)
    }

    document.addEventListener('fullscreenchange', syncFullscreenState)
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState)
  }, [])

  useEffect(() => {
    const shell = canvasShellRef.current
    if (!shell) {
      return undefined
    }

    let animationFrame = 0
    const updatePreviewCanvasSize = () => {
      const computed = window.getComputedStyle(shell)
      const availableWidth = shell.clientWidth - Number.parseFloat(computed.paddingLeft) - Number.parseFloat(computed.paddingRight)
      const availableHeight = shell.clientHeight - Number.parseFloat(computed.paddingTop) - Number.parseFloat(computed.paddingBottom)
      const aspectRatio = settings.width / settings.height
      const width = Math.max(0, Math.min(availableWidth, availableHeight * aspectRatio))
      const height = aspectRatio > 0 ? width / aspectRatio : 0

      setPreviewCanvasSize((current) => (
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height }
      ))
    }

    const scheduleUpdate = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(updatePreviewCanvasSize)
    }

    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(shell)
    scheduleUpdate()

    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
    }
  }, [settings.height, settings.width])

  useEffect(() => {
    let animationFrame = 0

    const tick = () => {
      const audio = audioRef.current
      if (audio && !audio.paused && !isScrubbingRef.current) {
        const time = audio.currentTime
        currentTimeRef.current = time
        renderFrame(time)

        if (seekSliderRef.current) {
          seekSliderRef.current.value = String(time)
        }
        if (currentTimeValueRef.current) {
          currentTimeValueRef.current.textContent = formatTime(time)
        }
      }

      animationFrame = requestAnimationFrame(tick)
    }

    animationFrame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(animationFrame)
    }
  }, [renderFrame])

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
      }

      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current)
      }

      if (frameSequenceUrlRef.current) {
        URL.revokeObjectURL(frameSequenceUrlRef.current)
      }

      if (paletteImageUrlRef.current) {
        URL.revokeObjectURL(paletteImageUrlRef.current)
      }

      if (coverUrlRef.current) {
        URL.revokeObjectURL(coverUrlRef.current)
      }

      if (backgroundImageUrlRef.current) {
        URL.revokeObjectURL(backgroundImageUrlRef.current)
      }

      if (brandIconUrlRef.current) {
        URL.revokeObjectURL(brandIconUrlRef.current)
      }

      importedFontsRef.current.forEach((font) => URL.revokeObjectURL(font.url))
    }
  }, [])

  const updateSetting = <K extends keyof VisualizerSettings>(key: K, value: VisualizerSettings[K]) => {
    if (isExporting) {
      return
    }

    setSettings((current) => ({
      ...current,
      [key]: value,
    }))

    if (['backgroundColor', 'lyricColor', 'progressColor', 'nextColor', 'metaColor'].includes(key)) {
      setActivePaletteId('custom')
      setPaletteSwatches([
        key === 'backgroundColor' ? String(value) : settings.backgroundColor,
        key === 'progressColor' ? String(value) : settings.progressColor,
        key === 'lyricColor' ? String(value) : settings.lyricColor,
        key === 'nextColor' ? String(value) : settings.nextColor,
        key === 'metaColor' ? String(value) : settings.metaColor,
      ])
    }
  }

  const selectVisualStyle = (visualStyle: VisualizerSettings['visualStyle']) => {
    if (isExporting) {
      return
    }

    setSettings((current) => {
      if (visualStyle === 'tiktok') {
        return {
          ...current,
          width: 1080,
          height: 1920,
          backgroundColor: '#000000',
          transparentBackground: false,
          lyricColor: '#050505',
          progressColor: '#050505',
          nextColor: '#050505',
          englishFont: tiktokReferenceFont,
          fontSize: 146,
          visualStyle,
          lyricAlignment: 'left',
          lyricHighlightMode: 'instant',
          showMetadata: false,
          showProgressBar: false,
          showBeatBar: false,
        }
      }

      if (visualStyle !== 'single') {
        return { ...current, visualStyle }
      }

      return {
        ...current,
        visualStyle,
        lyricAlignment: 'center',
        lyricHighlightMode: 'focus',
        showMetadata: false,
        showProgressBar: false,
      }
    })
  }

  const updateActiveTextSize = (value: number) => {
    const key = resolveTextElementSettingKey(activeTextElement)
    updateSetting(key, value)
  }

  const updateActiveTextColor = (value: string) => {
    const key = resolveTextElementColorKey(activeTextElement)
    updateSetting(key, value)
  }

  const applyPalette = (palette: VisualizerPalette) => {
    if (isExporting) {
      return
    }

    setSettings((current) => ({
      ...current,
      backgroundColor: palette.backgroundColor,
      lyricColor: palette.lyricColor,
      progressColor: palette.progressColor,
      nextColor: palette.nextColor,
      metaColor: palette.metaColor,
    }))
    setPaletteSwatches([
      palette.backgroundColor,
      palette.progressColor,
      palette.lyricColor,
      palette.nextColor,
      palette.metaColor,
    ])
    setActivePaletteId(palette.id)
  }

  const handlePaletteImage = async (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    setPaletteStatus(ui('正在进行感知色彩分析…', 'Analyzing perceptual colors…'))

    try {
      const result = await extractImagePalette(file)
      const url = URL.createObjectURL(file)

      if (paletteImageUrlRef.current) {
        URL.revokeObjectURL(paletteImageUrlRef.current)
      }

      paletteImageUrlRef.current = url
      setPaletteImageUrl(url)
      setPaletteSourceName(file.name)
      setPaletteSwatches(result.swatches)
      applyPalette(result.palette)
      setPaletteSwatches(result.swatches)
      setPaletteStatus(ui(
        `已从 ${file.name} 提取 ${result.swatches.length} 个主色，并自动匹配歌词层级`,
        `Extracted ${result.swatches.length} key colors from ${file.name} and matched them to the lyric hierarchy`,
      ))
    } catch (error) {
      setPaletteStatus(error instanceof Error
        ? localizeErrorMessage(error.message, language)
        : ui('图片配色分析失败', 'Image palette analysis failed'))
    }
  }

  const updatePreviewClock = (time: number) => {
    const nextTime = clampNumber(time, 0, Math.max(0, audioDuration))
    currentTimeRef.current = nextTime

    if (seekSliderRef.current) {
      seekSliderRef.current.value = String(nextTime)
    }
    if (currentTimeValueRef.current) {
      currentTimeValueRef.current.textContent = formatTime(nextTime)
    }
    renderFrame(nextTime)
    return nextTime
  }

  const togglePreviewFullscreen = async () => {
    const shell = canvasShellRef.current
    if (!shell) {
      return
    }

    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen()
      } else {
        await shell.requestFullscreen()
      }
    } catch {
      setExportStatus(ui('当前浏览器无法进入全屏预览', 'This browser cannot enter full-screen preview'))
    }
  }

  const replaceCover = (blob: Blob, name: string) => {
    if (coverUrlRef.current) {
      URL.revokeObjectURL(coverUrlRef.current)
    }

    const url = URL.createObjectURL(blob)
    coverUrlRef.current = url
    setCoverUrl(url)
    setCoverName(name)
  }

  const handleCoverFile = (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    replaceCover(file, file.name)
  }

  const replaceBackgroundImage = (blob: Blob, name: string) => {
    if (backgroundImageUrlRef.current) {
      URL.revokeObjectURL(backgroundImageUrlRef.current)
    }

    const url = URL.createObjectURL(blob)
    backgroundImageUrlRef.current = url
    setBackgroundImageUrl(url)
    setBackgroundImageName(name)
    setSettings((current) => ({ ...current, transparentBackground: false }))
  }

  const handleBackgroundImageFile = (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    replaceBackgroundImage(file, file.name)
  }

  const clearBackgroundImage = () => {
    if (backgroundImageUrlRef.current) {
      URL.revokeObjectURL(backgroundImageUrlRef.current)
    }

    backgroundImageUrlRef.current = null
    backgroundImageRef.current = null
    setBackgroundImageUrl('')
    setBackgroundImageName('')
    setBackgroundImageSize(null)
    setBackgroundImageRenderVersion((version) => version + 1)
  }

  const replaceBrandIcon = (blob: Blob, name: string) => {
    if (brandIconUrlRef.current) {
      URL.revokeObjectURL(brandIconUrlRef.current)
    }

    const url = URL.createObjectURL(blob)
    brandIconUrlRef.current = url
    setBrandIconUrl(url)
    setBrandIconName(name)
  }

  const handleBrandIconFile = (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    replaceBrandIcon(file, file.name)
  }

  const handleAudioFile = (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
    }

    const url = URL.createObjectURL(file)
    audioUrlRef.current = url
    audioFileRef.current = file
    audioReactiveEnvelopeRef.current = null
    setAudioAnalysisVersion((version) => version + 1)
    setBeatAnalysisStatus(ui('正在分析低频鼓点…', 'Analyzing low-frequency beats…'))
    setAudioUrl(url)
    setAudioFileName(file.name)
    setSongTitle(stripExtension(file.name))
    setSongArtist('')
    setExportStatus(ui('音频已载入', 'Audio loaded'))
    currentTimeRef.current = 0
    setExportRangeMode('full')
    setExportStartTime(0)

    void analyzeAudioFile(file).then((envelope) => {
      if (audioUrlRef.current !== url) {
        return
      }

      audioReactiveEnvelopeRef.current = envelope
      setAudioAnalysisVersion((version) => version + 1)
      setBeatAnalysisStatus(ui('鼓点分析完成，预览与导出将保持同步', 'Beat analysis complete; preview and export will stay in sync'))
    }).catch(() => {
      if (audioUrlRef.current === url) {
        audioReactiveEnvelopeRef.current = null
        setAudioAnalysisVersion((version) => version + 1)
        setBeatAnalysisStatus(ui('未能分析鼓点，律动条将保持静止', 'Beat analysis failed; the reactive bar will remain still'))
      }
    })

    void readAudioMetadata(file).then((metadata) => {
      if (audioUrlRef.current !== url) {
        return
      }

      if (metadata.title) {
        setSongTitle(metadata.title)
      }
      if (metadata.artist) {
        setSongArtist(metadata.artist)
      }
      if (metadata.cover) {
        replaceCover(metadata.cover, 'MP3 内嵌封面')
        setExportStatus(ui('音频已载入 · 已读取内嵌标题、歌手或封面', 'Audio loaded · Embedded title, artist, or artwork found'))
      }
    }).catch(() => {
      // Metadata is an optional enhancement; unsupported files should still import normally.
    })
  }

  const handleLrcFile = async (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    try {
      const decoded = await decodeLrcFile(file)
      const parsed = parseLrc(decoded.text, decoded.encoding)
      setParsedLrc(parsed)
      setLrcFileName(file.name)
      setLrcEncoding(decoded.encoding)
      if (parsed.metadata.ti || parsed.metadata.title) {
        setSongTitle(parsed.metadata.ti || parsed.metadata.title)
      }
      if (parsed.metadata.ar || parsed.metadata.artist) {
        setSongArtist(parsed.metadata.ar || parsed.metadata.artist)
      }
      setExportStatus(ui(`歌词已载入：${parsed.lines.length} 行`, `Lyrics loaded: ${parsed.lines.length} lines`))
      currentTimeRef.current = 0

      if (audioRef.current) {
        audioRef.current.currentTime = 0
      }
    } catch (error) {
      setExportStatus(error instanceof Error
        ? localizeErrorMessage(error.message, language)
        : ui('LRC 文件读取失败', 'Unable to read the LRC file'))
    }
  }

  const openTimingEditor = (source: TimingEditorSource) => {
    audioRef.current?.pause()
    setIsPlaying(false)
    setIsPasteLyricsOpen(false)
    setTimingEditorSource(source)
  }

  const openCurrentLyricsInTimingEditor = () => {
    openTimingEditor({
      name: lrcFileName || 'lyrics.lrc',
      encoding: lrcEncoding || parsedLrc.encoding || 'UTF-8',
      metadata: parsedLrc.metadata,
      lines: parsedLrc.lines.map((line) => ({
        id: line.id,
        text: line.text,
        startTime: line.time,
        endTime: line.endTime,
        words: line.words,
      })),
    })
  }

  const handleTxtFile = async (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    try {
      const decoded = await decodeLrcFile(file)
      const textLines = parsePlainTextLyrics(decoded.text)
      if (textLines.length === 0) {
        setExportStatus(ui('TXT 中没有可用的歌词行', 'The TXT file contains no usable lyric lines'))
        return
      }
      openTimingEditor({
        name: file.name,
        encoding: decoded.encoding,
        metadata: {},
        lines: textLines.map((text, index) => ({
          id: `txt-${index}-${crypto.randomUUID()}`,
          text,
          words: [],
        })),
      })
      setExportStatus(ui(
        `已读取 ${textLines.length} 行纯文本歌词，请在打轴器中标记时间`,
        `Loaded ${textLines.length} plain-text lyric lines. Add timing in the timing editor.`,
      ))
    } catch (error) {
      setExportStatus(error instanceof Error
        ? localizeErrorMessage(error.message, language)
        : ui('TXT 文件读取失败', 'Unable to read the TXT file'))
    }
  }

  const openPasteLyricsDialog = () => {
    if (isExporting) {
      return
    }
    audioRef.current?.pause()
    setIsPlaying(false)
    setPasteLyricsError('')
    setIsPasteLyricsOpen(true)
  }

  const startTimingPastedLyrics = () => {
    const textLines = parsePlainTextLyrics(pastedLyricsText)
    if (textLines.length === 0) {
      setPasteLyricsError(ui('请至少粘贴一行歌词。', 'Paste at least one lyric line.'))
      return
    }

    openTimingEditor({
      name: ui('粘贴歌词.txt', 'pasted-lyrics.txt'),
      encoding: 'UTF-8',
      metadata: {},
      lines: textLines.map((text, index) => ({
        id: `paste-${index}-${crypto.randomUUID()}`,
        text,
        words: [],
      })),
    })
    setPastedLyricsText('')
    setPasteLyricsError('')
    setExportStatus(ui(
      `已读取 ${textLines.length} 行粘贴歌词，请在打轴器中标记时间`,
      `Loaded ${textLines.length} pasted lyric lines. Add timing in the timing editor.`,
    ))
  }

  const applyTimedLyrics = (lines: LyricLine[], sourceName: string) => {
    if (!timingEditorSource) {
      return
    }
    const nextParsed: ParsedLrc = {
      lines,
      metadata: timingEditorSource.metadata,
      encoding: timingEditorSource.encoding,
    }
    setParsedLrc(nextParsed)
    setLrcFileName(sourceName.replace(/\.txt$/i, '.lrc'))
    setLrcEncoding(timingEditorSource.encoding)
    if (nextParsed.metadata.ti || nextParsed.metadata.title) {
      setSongTitle(nextParsed.metadata.ti || nextParsed.metadata.title)
    }
    if (nextParsed.metadata.ar || nextParsed.metadata.artist) {
      setSongArtist(nextParsed.metadata.ar || nextParsed.metadata.artist)
    }
    currentTimeRef.current = 0
    if (audioRef.current) {
      audioRef.current.currentTime = 0
    }
    setTimingEditorSource(null)
    setExportStatus(ui(
      `打轴已应用：${lines.length} 行${lines.some((line) => line.endTime !== undefined) ? ' · 含独立句尾' : ''}`,
      `Timing applied: ${lines.length} lines${lines.some((line) => line.endTime !== undefined) ? ' · Includes explicit line ends' : ''}`,
    ))
  }

  const alignCurrentLyricsLocally = async () => {
    const audioFile = audioFileRef.current
    if (!audioFile) {
      setExportStatus(ui('请先导入音频，再运行本地逐词对齐', 'Import audio before running local word alignment'))
      return
    }
    if (parsedLrc.lines.length === 0) {
      setExportStatus(ui('请先导入或打轴歌词', 'Import or time lyrics first'))
      return
    }

    audioRef.current?.pause()
    setIsAligningLyrics(true)
    setExportStatus(ui('正在浏览器内分析声音起点并生成逐词时间…', 'Analyzing sound onsets and generating word timing in your browser…'))
    try {
      const result = await alignLyricsToAudio(audioFile, parsedLrc.lines, audioDuration)
      setParsedLrc((current) => ({ ...current, lines: result.lines }))
      setExportStatus(ui(
        `本地逐词对齐完成：${result.alignedLineCount} 句 · 参考置信度 ${Math.round(result.confidence * 100)}%`,
        `Local word alignment complete: ${result.alignedLineCount} lines · ${Math.round(result.confidence * 100)}% reference confidence`,
      ))
    } catch (error) {
      setExportStatus(error instanceof Error
        ? localizeErrorMessage(error.message, language)
        : ui('本地逐词对齐失败', 'Local word alignment failed'))
    } finally {
      setIsAligningLyrics(false)
    }
  }

  const handleFontFile = async (file: File | undefined) => {
    if (!file || isExporting) {
      return
    }

    try {
      const url = URL.createObjectURL(file)
      const family = `LRCFont_${crypto.randomUUID().replaceAll('-', '')}`
      const fontFace = new FontFace(family, `url(${url})`)
      await fontFace.load()
      document.fonts.add(fontFace)
      const importedFont = {
        id: family,
        name: stripExtension(file.name),
        family,
        url,
      }
      importedFontsRef.current = [...importedFontsRef.current, importedFont]
      setImportedFonts((current) => [...current, importedFont])
      setFontStatus(ui(`已导入：${file.name}`, `Imported: ${file.name}`))
    } catch {
      setFontStatus(ui('字体导入失败，请确认是 ttf/otf/woff/woff2', 'Font import failed. Use a TTF, OTF, WOFF, or WOFF2 file.'))
    }
  }

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio || isExporting) {
      return
    }

    if (audio.paused) {
      await audio.play()
      setIsPlaying(true)
    } else {
      audio.pause()
      setIsPlaying(false)
    }
  }

  const seekTo = (time: number) => {
    if (isExporting) {
      return
    }

    const nextTime = updatePreviewClock(time)
    const audio = audioRef.current

    if (audio) {
      audio.currentTime = nextTime
    }
  }

  const seekBy = (offset: number) => {
    seekTo(currentTimeRef.current + offset)
  }

  const beginScrub = () => {
    if (isExporting || isScrubbingRef.current) {
      return
    }

    const audio = audioRef.current
    isScrubbingRef.current = true
    resumeAfterScrubRef.current = Boolean(audio && !audio.paused)
    audio?.pause()
  }

  const previewScrub = (time: number) => {
    if (isExporting) {
      return
    }

    if (!isScrubbingRef.current) {
      beginScrub()
    }

    updatePreviewClock(time)
  }

  const commitScrub = () => {
    if (!isScrubbingRef.current) {
      return
    }

    const audio = audioRef.current
    const shouldResume = resumeAfterScrubRef.current
    isScrubbingRef.current = false
    resumeAfterScrubRef.current = false

    if (audio) {
      audio.currentTime = currentTimeRef.current
      if (shouldResume && !isExporting) {
        void audio.play()
      }
    }
  }

  const updateExportStartTime = (time: number) => {
    setExportStartTime(clampNumber(time, 0, audioDuration))
  }

  const updateExportEndTime = (time: number) => {
    setExportEndTime(clampNumber(time, 0, audioDuration))
  }

  const startExport = async () => {
    if (!audioUrl || !audioFileName) {
      setExportStatus(ui('请先导入音频', 'Import audio first'))
      return
    }

    if (parsedLrc.lines.length === 0) {
      setExportStatus(ui('请先导入 LRC 歌词', 'Import LRC lyrics first'))
      return
    }

    const rangeStart = exportRangeMode === 'selection'
      ? clampNumber(exportStartTime, 0, audioDuration)
      : 0
    const rangeEnd = exportRangeMode === 'selection'
      ? clampNumber(exportEndTime, 0, audioDuration)
      : audioDuration

    if (rangeEnd - rangeStart < minimumExportDuration) {
      setExportStatus(ui('结束点必须晚于开始点至少 0.1 秒', 'The end must be at least 0.1 seconds after the start'))
      return
    }

    const support = await getDirectExportSupport(settings)
    setFastExportSupport(support)
    if (!support.supported) {
      setExportStatus(support.reason
        ? localizeErrorMessage(support.reason, language)
        : ui('当前浏览器不支持直接导出', 'This browser does not support direct export'))
      return
    }

    audioRef.current?.pause()

    setIsExporting(true)
    setExportProgress(0)
    setExportCurrentTime(rangeStart)
    setExportResult(null)
    setExportStatus(ui(
      `正在离屏编码 ${support.format ?? '视频'} ${formatTimePrecise(rangeStart)}–${formatTimePrecise(rangeEnd)}`,
      `Encoding ${support.format ?? 'video'} offscreen ${formatTimePrecise(rangeStart)}–${formatTimePrecise(rangeEnd)}`,
    ))

    try {
      await document.fonts.ready
      const result: ExportResult = await fastExportVisualizer({
        audioUrl,
        audioFileName,
        lines: parsedLrc.lines,
        duration: audioDuration,
        startTime: rangeStart,
        endTime: rangeEnd,
        settings,
        title,
        artist,
        coverImage: coverImageRef.current ?? undefined,
        backgroundImage: backgroundImageRef.current ?? undefined,
        brandIconImage: brandIconImageRef.current ?? undefined,
        sodaBrandText,
        sodaPlaylistText,
        audioReactiveEnvelope: audioReactiveEnvelopeRef.current ?? undefined,
        onProgress: (progress, time) => {
          setExportProgress(progress)
          setExportCurrentTime(time)
        },
      })
      setExportStatus(ui(
        `${result.mimeType === 'video/mp4' ? 'MP4' : 'WebM'} 已直接生成`,
        `${result.mimeType === 'video/mp4' ? 'MP4' : 'WebM'} generated successfully`,
      ))

      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current)
      }

      resultUrlRef.current = result.url
      setExportResult(result)
    } catch (error) {
      setExportStatus(error instanceof Error
        ? localizeErrorMessage(error.message, language)
        : ui('导出失败', 'Export failed'))
    } finally {
      setIsExporting(false)
      renderFrame(currentTimeRef.current)
    }
  }

  const startTikTokFrameExport = async () => {
    if (settings.visualStyle !== 'tiktok') {
      return
    }

    if (parsedLrc.lines.length === 0) {
      setExportStatus(ui('请先导入带时间轴的歌词', 'Import timed lyrics first'))
      return
    }

    const rangeStart = exportRangeMode === 'selection'
      ? clampNumber(exportStartTime, 0, audioDuration)
      : 0
    const rangeEnd = exportRangeMode === 'selection'
      ? clampNumber(exportEndTime, 0, audioDuration)
      : audioDuration

    if (rangeEnd - rangeStart < minimumExportDuration) {
      setExportStatus(ui('结束点必须晚于开始点至少 0.1 秒', 'The end must be at least 0.1 seconds after the start'))
      return
    }

    audioRef.current?.pause()
    setIsExporting(true)
    setExportProgress(0)
    setExportCurrentTime(rangeStart)
    setExportStatus(ui('正在生成逐词 PNG 序列…', 'Generating word-by-word PNG sequence…'))

    try {
      await document.fonts.ready
      const result = await exportTikTokWordFrames({
        lines: parsedLrc.lines,
        duration: audioDuration,
        startTime: rangeStart,
        endTime: rangeEnd,
        settings,
        title,
        artist,
        coverImage: coverImageRef.current ?? undefined,
        backgroundImage: backgroundImageRef.current ?? undefined,
        brandIconImage: brandIconImageRef.current ?? undefined,
        sodaBrandText,
        sodaPlaylistText,
        onProgress: (progress, time, frameCount) => {
          setExportProgress(progress)
          setExportCurrentTime(time)
          setExportStatus(ui(
            `正在生成逐词 PNG ${Math.round(progress * 100)}%（${frameCount} 张）`,
            `Generating word PNGs ${Math.round(progress * 100)}% (${frameCount} frames)`,
          ))
        },
      })

      if (frameSequenceUrlRef.current) {
        URL.revokeObjectURL(frameSequenceUrlRef.current)
      }

      frameSequenceUrlRef.current = result.url
      setFrameSequenceResult(result)
      setExportStatus(ui(
        `已生成 ${result.frameCount} 张 PNG，并打包为 ZIP`,
        `Generated ${result.frameCount} PNG files and packaged them as a ZIP`,
      ))
    } catch (error) {
      setExportStatus(error instanceof Error
        ? localizeErrorMessage(error.message, language)
        : ui('逐词 PNG 导出失败', 'Word-by-word PNG export failed'))
    } finally {
      setIsExporting(false)
      renderFrame(currentTimeRef.current)
    }
  }

  const selectedSize = `${settings.width}x${settings.height}`
  const selectedRangeDuration = Math.max(0, exportEndTime - exportStartTime)
  const hasValidSelection = exportRangeMode === 'full' || selectedRangeDuration >= minimumExportDuration
  const tiktokFrameCount = useMemo(() => {
    if (settings.visualStyle !== 'tiktok' || parsedLrc.lines.length === 0) {
      return 0
    }

    const rangeStart = exportRangeMode === 'selection'
      ? clampNumber(exportStartTime, 0, audioDuration)
      : 0
    const rangeEnd = exportRangeMode === 'selection'
      ? clampNumber(exportEndTime, 0, audioDuration)
      : audioDuration

    return getTikTokWordFrameTimeline(parsedLrc.lines, audioDuration, rangeStart, rangeEnd).length
  }, [audioDuration, exportEndTime, exportRangeMode, exportStartTime, parsedLrc.lines, settings.visualStyle])
  const previewTime = isExporting ? exportCurrentTime : currentTimeRef.current
  const exportBadge = fastExportSupport === null
    ? ui('检测中', 'Checking')
    : fastExportSupport.supported
      ? `DIRECT ${fastExportSupport.format ?? 'VIDEO'}`
      : ui('不可用', 'Unavailable')
  const exportButtonLabel = isExporting
    ? ui(`正在导出 ${Math.round(exportProgress * 100)}%`, `Exporting ${Math.round(exportProgress * 100)}%`)
    : exportRangeMode === 'selection' ? ui('直接导出选定片段', 'Export selected range') : ui('直接导出完整视频', 'Export full video')
  const canvasStyle = {
    '--canvas-ratio': String(settings.width / settings.height),
    ...(previewCanvasSize.width > 0 && previewCanvasSize.height > 0
      ? {
          '--preview-canvas-width': `${previewCanvasSize.width}px`,
          '--preview-canvas-height': `${previewCanvasSize.height}px`,
        }
      : {}),
    aspectRatio: `${settings.width} / ${settings.height}`,
  } as CSSProperties & {
    '--canvas-ratio': string
    '--preview-canvas-width'?: string
    '--preview-canvas-height'?: string
  }
  const appThemeStyle = {
    '--theme-background': settings.backgroundColor,
    '--theme-background-rgb': hexToRgbChannels(settings.backgroundColor),
    '--theme-accent': settings.progressColor,
    '--theme-accent-rgb': hexToRgbChannels(settings.progressColor),
    '--theme-lyric': settings.lyricColor,
    '--theme-lyric-rgb': hexToRgbChannels(settings.lyricColor),
    '--theme-muted': settings.nextColor,
  } as CSSProperties & Record<`--theme-${string}`, string>

  return (
    <main className="appShell" style={appThemeStyle}>
      <header className="appHeader">
        <div className="appIdentity" aria-label="LRC Visual Studio">LRC Visual Studio</div>
        <span className="headerDivider" aria-hidden="true" />
        <span className="projectName" title={title || ui('未命名项目', 'Untitled project')}>{title || ui('未命名项目', 'Untitled project')}</span>
        <div className="headerActions">
          <div className="languageSwitch" role="group" aria-label={ui('界面语言', 'Interface language')}>
            <button type="button" className={language === 'zh' ? 'active' : ''} aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
            <button type="button" className={language === 'en' ? 'active' : ''} aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>EN</button>
          </div>
          <span className="autosaveStatus">{saveStatus}</span>
          <button
            className="previewHeaderButton"
            type="button"
            onClick={() => void togglePreviewFullscreen()}
          >
            {ui('预览', 'Preview')}
          </button>
          <button
            className="headerExportButton"
            type="button"
            disabled={isExporting || fastExportSupport === null || !fastExportSupport.supported || !hasValidSelection}
            onClick={() => void startExport()}
          >
            {isExporting ? ui(`导出 ${Math.round(exportProgress * 100)}%`, `Exporting ${Math.round(exportProgress * 100)}%`) : ui('导出视频', 'Export video')}
          </button>
        </div>
      </header>

      <section className="editorGrid">
        <aside className="projectSidebar" aria-label={ui('项目素材', 'Project assets')}>
          <section className="sidebarSection projectSection" inert={isExporting}>
            <div className="sidebarTitleRow">
              <h2>{ui('项目', 'Project')}</h2>
              <span>{ui('素材与内容', 'Assets & content')}</span>
            </div>

            <label className={audioFileName ? 'compactFileRow isReady' : 'compactFileRow'}>
              <span className="assetState" aria-hidden="true">{audioFileName ? '✓' : '♪'}</span>
              <span className="assetCopy">
                <strong>{ui('音频', 'Audio')}</strong>
                <small>{audioFileName || ui('导入音频文件', 'Import an audio file')}</small>
              </span>
              <span className="assetAction">{audioFileName ? ui('替换', 'Replace') : ui('添加', 'Add')}</span>
              <input type="file" accept="audio/*" onChange={(event) => handleAudioFile(event.target.files?.[0])} />
            </label>

            <div className="lyricsImportBlock">
              <label className={lrcFileName ? 'compactFileRow isReady' : 'compactFileRow'}>
                <span className="assetState assetStateLrc" aria-hidden="true">{lrcFileName ? '✓' : 'LRC'}</span>
                <span className="assetCopy">
                  <strong>{ui('带时间 LRC', 'Timed LRC')}</strong>
                  <small>{lrcFileName || ui('直接导入已有时间轴', 'Import an existing timeline')}</small>
                </span>
                <span className="assetAction">{lrcFileName ? ui('替换', 'Replace') : ui('导入', 'Import')}</span>
                <input type="file" accept=".lrc" onChange={(event) => void handleLrcFile(event.target.files?.[0])} />
              </label>

              <label className="compactFileRow compactFileRowSecondary">
                <span className="assetState assetStateTxt" aria-hidden="true">TXT</span>
                <span className="assetCopy">
                  <strong>{ui('纯 TXT → 打轴器', 'Plain TXT → timing editor')}</strong>
                  <small>{ui('逐句标记句首与独立句尾', 'Mark each line start and optional end')}</small>
                </span>
                <span className="assetAction">{ui('打轴', 'Time')}</span>
                <input type="file" accept=".txt,text/plain" onChange={(event) => void handleTxtFile(event.target.files?.[0])} />
              </label>

              <button className="pasteLyricsTrigger" type="button" disabled={isExporting} onClick={openPasteLyricsDialog}>
                <span aria-hidden="true">＋</span>
                <span><strong>{ui('直接粘贴歌词', 'Paste lyrics')}</strong><small>{ui('无需保存 TXT，按换行自动拆句', 'Split into lines without saving a TXT file')}</small></span>
                <span aria-hidden="true">{ui('粘贴', 'Paste')}</span>
              </button>

              <div className="lyricToolActions">
                <button type="button" disabled={parsedLrc.lines.length === 0 || isExporting} onClick={openCurrentLyricsInTimingEditor}>{ui('打开打轴器', 'Open timing editor')}</button>
                <button type="button" disabled={!audioFileName || parsedLrc.lines.length === 0 || isAligningLyrics || isExporting} onClick={() => void alignCurrentLyricsLocally()}>
                  {isAligningLyrics ? ui('对齐中…', 'Aligning…') : ui('本地逐词对齐', 'Local word alignment')}
                </button>
              </div>
            </div>

            <label className={coverUrl ? 'compactFileRow isReady' : 'compactFileRow'}>
              {coverUrl ? <img src={coverUrl} alt={ui('当前专辑封面', 'Current album cover')} className="coverInputPreview" /> : <span className="assetState" aria-hidden="true">▣</span>}
              <span className="assetCopy">
                <strong>{ui('专辑封面', 'Album cover')}</strong>
                <small>{coverName || ui('可从 MP3 读取或手动添加', 'Read from MP3 metadata or add manually')}</small>
              </span>
              <span className="assetAction">{coverUrl ? ui('替换', 'Replace') : ui('添加', 'Add')}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleCoverFile(event.target.files?.[0])} />
            </label>

            <label className={backgroundImageUrl ? 'compactFileRow isReady' : 'compactFileRow'}>
              {backgroundImageUrl ? <img src={backgroundImageUrl} alt={ui('当前自定义背景', 'Current custom background')} className="coverInputPreview" /> : <span className="assetState" aria-hidden="true">▧</span>}
              <span className="assetCopy">
                <strong>{ui('画面背景', 'Canvas background')}</strong>
                <small>{backgroundImageName || ui('上传图片，自动适配当前画幅', 'Upload an image and fit it to the canvas')}</small>
              </span>
              <span className="assetAction">{backgroundImageUrl ? ui('替换', 'Replace') : ui('添加', 'Add')}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleBackgroundImageFile(event.target.files?.[0])} />
            </label>

            <div className="sidebarSubheading">{ui('歌曲信息', 'Song details')}</div>
            <label className={activeTextElement === 'title' ? 'compactTextField active' : 'compactTextField'}>
              <span>{ui('歌名', 'Song title')}</span>
              <input
                type="text"
                value={songTitle}
                placeholder={stripExtension(lrcFileName || audioFileName) || ui('输入歌名', 'Enter song title')}
                onFocus={() => setActiveTextElement('title')}
                onChange={(event) => setSongTitle(event.target.value)}
              />
            </label>
            <label className={activeTextElement === 'artist' ? 'compactTextField active' : 'compactTextField'}>
              <span>{ui('歌手', 'Artist')}</span>
              <input
                type="text"
                value={songArtist}
                placeholder={ui('输入歌手名', 'Enter artist name')}
                onFocus={() => setActiveTextElement('artist')}
                onChange={(event) => setSongArtist(event.target.value)}
              />
            </label>

            <button
              className="disclosureButton"
              type="button"
              aria-expanded={isPromoExpanded}
              onClick={() => setIsPromoExpanded((expanded) => !expanded)}
            >
              <span aria-hidden="true">{isPromoExpanded ? '⌄' : '›'}</span>
              {ui('宣传文案与歌单入口', 'Banner copy & playlist link')}
            </button>
            {isPromoExpanded && (
              <div className="promoFields">
                <label className={activeTextElement === 'brand' ? 'compactTextField active' : 'compactTextField'}>
                  <span>{ui('顶部宣传栏', 'Top banner')}</span>
                  <input type="text" value={sodaBrandText} onFocus={() => setActiveTextElement('brand')} onChange={(event) => setSodaBrandText(event.target.value)} />
                </label>
                <label className={activeTextElement === 'playlist' ? 'compactTextField active' : 'compactTextField'}>
                  <span>{ui('歌单入口', 'Playlist link')}</span>
                  <input type="text" value={sodaPlaylistText} onFocus={() => setActiveTextElement('playlist')} onChange={(event) => setSodaPlaylistText(event.target.value)} />
                </label>
                <label className={brandIconUrl ? 'compactFileRow isReady compactBrandIconRow' : 'compactFileRow compactBrandIconRow'}>
                  {brandIconUrl ? <img src={brandIconUrl} alt={ui('当前顶部图标', 'Current top icon')} className="coverInputPreview" /> : <span className="assetState" aria-hidden="true">♪</span>}
                  <span className="assetCopy">
                    <strong>{ui('顶部图标', 'Top icon')}</strong>
                    <small>{brandIconName || ui('默认音乐图标，可上传替换', 'Default music icon; upload to replace')}</small>
                  </span>
                  <span className="assetAction">{brandIconUrl ? ui('替换', 'Replace') : ui('添加', 'Add')}</span>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleBrandIconFile(event.target.files?.[0])} />
                </label>
              </div>
            )}
          </section>
        </aside>

      <section className="workspace">
        <section className="previewPanel">
          <div className="previewToolbar">
            <span className="previewLabel">{ui('适应窗口', 'Fit to window')}</span>
            <span className="previewScale">{Math.round(getPreviewRenderScale(settings) * 100)}%</span>
            <span className="formatBadge">{formatAspectRatio(settings.width, settings.height)}</span>
            <button
              className="previewFullscreenButton toolbarFullscreenButton"
              type="button"
              onClick={() => void togglePreviewFullscreen()}
              aria-label={isPreviewFullscreen ? ui('退出全屏预览', 'Exit full-screen preview') : ui('全屏预览', 'Full-screen preview')}
              title={isPreviewFullscreen ? ui('退出全屏预览', 'Exit full-screen preview') : ui('全屏预览', 'Full-screen preview')}
            >
              <span aria-hidden="true">⤢</span>
            </button>
          </div>
          <div ref={canvasShellRef} className={settings.transparentBackground ? 'canvasShell transparent' : 'canvasShell'}>
            <canvas
              ref={canvasRef}
              style={canvasStyle}
              data-orientation={settings.height > settings.width ? 'portrait' : settings.width > settings.height ? 'landscape' : 'square'}
              aria-label={ui(`${formatAspectRatio(settings.width, settings.height)} 歌词可视化预览`, `${formatAspectRatio(settings.width, settings.height)} lyric visualizer preview`)}
            />
            {isExporting && <span className="recordingBadge">{ui('EXPORT · 正在离屏逐帧编码', 'EXPORT · Encoding frames offscreen')}</span>}
          </div>
          <div className="transport">
            <div className="transportControls">
              <button className="jumpButton" type="button" onClick={() => seekBy(-5)} disabled={isExporting} title={ui('后退 5 秒', 'Back 5 seconds')}>
                <span aria-hidden="true">−5</span>
                <span className="srOnly">{ui('后退 5 秒', 'Back 5 seconds')}</span>
              </button>
              <button className="playButton" type="button" onClick={togglePlayback} disabled={!audioUrl || isExporting} title={isPlaying ? ui('暂停', 'Pause') : ui('播放', 'Play')}>
                <span aria-hidden="true">{isPlaying ? 'Ⅱ' : '▶'}</span>
                <span className="srOnly">{isPlaying ? ui('暂停', 'Pause') : ui('播放', 'Play')}</span>
              </button>
              <button className="jumpButton" type="button" onClick={() => seekBy(5)} disabled={isExporting} title={ui('快进 5 秒', 'Forward 5 seconds')}>
                <span aria-hidden="true">+5</span>
                <span className="srOnly">{ui('快进 5 秒', 'Forward 5 seconds')}</span>
              </button>
            </div>
            <div className="transportTimeline">
              <div className="transportMeta">
                <strong>{title || ui('未命名作品', 'Untitled')}</strong>
                <span className="timeReadout">
                  <span ref={currentTimeValueRef} className="currentTimeValue">{formatTime(previewTime)}</span>{' '}
                  <span>/</span> {formatTime(audioDuration)}
                </span>
              </div>
              <input
                ref={seekSliderRef}
                className="seekSlider"
                type="range"
                min={0}
                max={Math.max(0.01, audioDuration)}
                step={0.01}
                defaultValue={0}
                disabled={isExporting}
                aria-label={ui('预览播放进度', 'Preview playback position')}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  beginScrub()
                }}
                onInput={(event) => previewScrub(Number(event.currentTarget.value))}
                onPointerUp={commitScrub}
                onPointerCancel={commitScrub}
                onKeyDown={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                    beginScrub()
                  }
                }}
                onKeyUp={commitScrub}
                onBlur={commitScrub}
              />
            </div>
          </div>
        </section>

        <div className="hintBar">
          <span className="hintIcon" aria-hidden="true">i</span>
          <p>{ui('实时预览使用性能分辨率保证滚动流畅；导出仍按所选画幅的完整分辨率逐帧生成。', 'The live preview uses a performance resolution for smooth playback; export still renders every frame at the selected full resolution.')}</p>
        </div>

        <audio
          ref={audioRef}
          src={audioUrl || undefined}
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration
            const safeDuration = Number.isFinite(duration) ? duration : 9
            setAudioDuration(safeDuration)
            setExportStartTime(0)
            setExportEndTime(safeDuration)
            updatePreviewClock(event.currentTarget.currentTime)
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={(event) => {
            setIsPlaying(false)
            updatePreviewClock(event.currentTarget.currentTime)
          }}
        />
      </section>

      <aside className={`${isExporting ? 'controlPanel isExporting' : 'controlPanel'} active-${activeStyleTab}`} aria-busy={isExporting}>
        <div className="panelHeading">
          <div>
            <p>{ui('编辑器', 'Editor')}</p>
            <strong>{ui('画面设置', 'Visual settings')}</strong>
          </div>
          <div className="panelHeadingActions">
            <span className="autosaveStatus">{ui('实时预览', 'Live preview')}</span>
            <button
              className="headerExportButton"
              type="button"
              disabled={isExporting || fastExportSupport === null || !fastExportSupport.supported || !hasValidSelection}
              onClick={() => void startExport()}
            >
              {ui('导出视频', 'Export video')}
            </button>
            <span className="readyMark" title={ui('实时预览已连接', 'Live preview connected')} aria-label={ui('实时预览已连接', 'Live preview connected')} />
          </div>
        </div>

        <div className="styleTabs" role="tablist" aria-label={ui('样式设置分组', 'Settings sections')}>
          {([
            ['scene', ui('画面与背景', 'Canvas & background')],
            ['lyrics', ui('歌词与文字', 'Lyrics & text')],
            ['typeMotion', ui('字体与动效', 'Fonts & motion')],
          ] as const).map(([tab, label]) => (
            <button
              key={tab}
              className={activeStyleTab === tab ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={activeStyleTab === tab}
              onClick={() => setActiveStyleTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="panelGroup projectAssetPanel" inert={isExporting}>
          <h2>{ui('项目素材', 'Project assets')}</h2>
          <label className="fileInput">
            <span className="fileIcon" aria-hidden="true">♪</span>
            <span className="fileCopy">
              <strong>{ui('导入音频文件', 'Import audio')}</strong>
              <small>{audioFileName || ui('支持 MP3 / WAV / M4A 等格式', 'Supports MP3, WAV, M4A, and more')}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept="audio/*" onChange={(event) => handleAudioFile(event.target.files?.[0])} />
          </label>

          <label className="fileInput">
            <span className="fileIcon fileIconText" aria-hidden="true">LRC</span>
            <span className="fileCopy">
              <strong>{ui('导入 LRC 歌词', 'Import LRC lyrics')}</strong>
              <small>{lrcFileName ? `${lrcFileName}${lrcEncoding ? ` · ${lrcEncoding}` : ''}` : ui('自动识别 UTF-8、GBK、Big5 与 UTF-16', 'Detects UTF-8, GBK, Big5, and UTF-16 automatically')}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept=".lrc" onChange={(event) => void handleLrcFile(event.target.files?.[0])} />
          </label>

          <label className="fileInput">
            <span className="fileIcon fileIconText" aria-hidden="true">TXT</span>
            <span className="fileCopy">
              <strong>{ui('导入纯 TXT 并打轴', 'Import plain TXT and add timing')}</strong>
              <small>{ui('在内置打轴器中分别设置句首和句尾', 'Set line starts and ends in the built-in timing editor')}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept=".txt,text/plain" onChange={(event) => void handleTxtFile(event.target.files?.[0])} />
          </label>

          <button className="pasteLyricsTrigger pasteLyricsTriggerWide" type="button" disabled={isExporting} onClick={openPasteLyricsDialog}>
            <span aria-hidden="true">＋</span>
            <span><strong>{ui('直接粘贴歌词', 'Paste lyrics')}</strong><small>{ui('把多行歌词粘贴进文本框后直接开始打轴', 'Paste multiple lines and start timing immediately')}</small></span>
            <span aria-hidden="true">{ui('粘贴', 'Paste')}</span>
          </button>

          <div className="metadataEditor">
            <label className="field">
              <span>{ui('歌名（画面左上角）', 'Song title (top left)')}</span>
              <input
                type="text"
                value={songTitle}
                placeholder={stripExtension(lrcFileName || audioFileName) || ui('输入歌名', 'Enter song title')}
                onChange={(event) => setSongTitle(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{ui('歌手', 'Artist')}</span>
              <input
                type="text"
                value={songArtist}
                placeholder={ui('输入歌手名', 'Enter artist name')}
                onChange={(event) => setSongArtist(event.target.value)}
              />
            </label>
          </div>

          <div className="sodaPromoEditor">
            <p>{ui('汽水音乐样式文案', 'Soda Music copy')}</p>
            <label className="field">
              <span>{ui('顶部宣传栏', 'Top banner')}</span>
              <input
                type="text"
                value={sodaBrandText}
                onChange={(event) => setSodaBrandText(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{ui('歌单入口', 'Playlist link')}</span>
              <input
                type="text"
                value={sodaPlaylistText}
                onChange={(event) => setSodaPlaylistText(event.target.value)}
              />
            </label>
          </div>

          <label className="fileInput coverInput">
            {coverUrl ? (
              <img src={coverUrl} alt={ui('当前专辑封面', 'Current album cover')} className="coverInputPreview" />
            ) : (
              <span className="fileIcon coverIcon" aria-hidden="true">▣</span>
            )}
            <span className="fileCopy">
              <strong>{ui('专辑封面', 'Album cover')}</strong>
              <small>{coverName || ui('导入 MP3 时自动读取内嵌封面，也可手动上传', 'Read embedded MP3 artwork automatically or upload manually')}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleCoverFile(event.target.files?.[0])} />
          </label>
        </section>

        <section className="panelGroup fontPanel" inert={isExporting}>
          <h2>{ui('字体', 'Fonts')}</h2>
          <label className="fileInput">
            <span className="fileIcon typeIcon" aria-hidden="true">T</span>
            <span className="fileCopy">
              <strong>{ui('导入字体', 'Import font')}</strong>
              <small>{fontStatus === '未导入字体' || fontStatus === 'No font imported' ? ui('支持 TTF / OTF / WOFF / WOFF2', 'Supports TTF, OTF, WOFF, and WOFF2') : fontStatus}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept=".ttf,.otf,.woff,.woff2,font/*" onChange={(event) => void handleFontFile(event.target.files?.[0])} />
          </label>

          <label className="field">
            <span>{ui('中文字体', 'Chinese font')}</span>
            <select value={settings.chineseFont} onChange={(event) => updateSetting('chineseFont', event.target.value)}>
              {fontOptions.map((font) => (
                <option key={`zh-${font.value}`} value={font.value}>{font.label}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{ui('英文字体', 'Latin font')}</span>
            <select value={settings.englishFont} onChange={(event) => updateSetting('englishFont', event.target.value)}>
              {fontOptions.map((font) => (
                <option key={`en-${font.value}`} value={font.value}>{font.label}</option>
              ))}
            </select>
          </label>
        </section>

        <section className="panelGroup typographyGroup lyricsPanel" inert={isExporting}>
          <div className="sectionTitleRow">
            <h2>{ui(`${activeTextElementLabel}设置`, `${activeTextElementLabel} settings`)}</h2>
            <span>{ui('已选中', 'Selected')}</span>
          </div>
          <div className="elementPicker" role="listbox" aria-label={ui('正在编辑的文字元素', 'Text element being edited')}>
            {([
              ['currentLyric', ui('当前歌词', 'Current lyric')],
              ['normalLyric', ui('普通歌词', 'Inactive lyrics')],
              ['title', ui('歌名', 'Song title')],
              ['artist', ui('歌手', 'Artist')],
              ['brand', ui('宣传栏', 'Banner')],
              ['playlist', ui('歌单入口', 'Playlist link')],
            ] as const).map(([element, label]) => (
              <button
                key={element}
                className={activeTextElement === element ? 'active' : ''}
                type="button"
                role="option"
                aria-selected={activeTextElement === element}
                onClick={() => setActiveTextElement(element)}
              >
                {label}
              </button>
            ))}
          </div>
          <RangeField
            label={ui('字号', 'Font size')}
            value={activeTextSize}
            min={getTextElementRange(activeTextElement).min}
            max={getTextElementRange(activeTextElement).max}
            unit="px"
            onChange={updateActiveTextSize}
          />
          <ColorField
            label={activeTextElement === 'currentLyric' ? ui('基础颜色', 'Base color') : activeTextElement === 'normalLyric' ? ui('普通歌词颜色', 'Inactive lyric color') : ui('文字颜色', 'Text color')}
            value={activeTextColor}
            onChange={updateActiveTextColor}
          />
          {settings.visualStyle === 'tiktok' && activeTextElement === 'currentLyric' && (
            <>
              <RangeField
                label={ui('文字柔化', 'Text softness')}
                value={settings.tiktokTextBlur}
                min={0}
                max={6}
                unit="px"
                onChange={(value) => updateSetting('tiktokTextBlur', value)}
              />
              <p className="singleLyricNote">{ui('0 px 为清晰边缘；约 2 px 接近参考图中轻微发虚的文字质感。', '0 px keeps crisp edges; around 2 px produces the slightly softened texture of the reference.')}</p>
            </>
          )}
          {(activeTextElement === 'currentLyric' || activeTextElement === 'normalLyric') && (
            settings.visualStyle === 'tiktok' ? (
              <p className="singleLyricNote">{ui('参考模板固定使用左侧 24% 锚点、47% 排版宽度和自动两端分布；字号与字体仍可在这里调整。', 'The reference layout uses a fixed 24% left anchor, 47% text width, and automatic justified distribution; font and size remain adjustable here.')}</p>
            ) : <>
              <label className="field">
                <span>{ui('歌词对齐', 'Lyric alignment')}</span>
                <select
                  value={settings.lyricAlignment}
                  onChange={(event) => updateSetting('lyricAlignment', event.target.value as VisualizerSettings['lyricAlignment'])}
                >
                  <option value="center">{ui('居中', 'Centered')}</option>
                  <option value="left">{ui('向左对齐', 'Left aligned')}</option>
                </select>
              </label>
              <RangeField label={ui('行距', 'Line spacing')} value={settings.lineGap} min={64} max={180} unit="px" onChange={(value) => updateSetting('lineGap', value)} />
            </>
          )}
        </section>

        <section className="panelGroup paletteGroup backgroundPanel" inert={isExporting}>
          <div className="sectionTitleRow">
            <h2>{ui('智能配色', 'Smart palette')}</h2>
            <span>LOCAL · OKLAB</span>
          </div>

          <label className="paletteUpload">
            {paletteImageUrl ? (
              <img src={paletteImageUrl} alt={ui('配色参考图预览', 'Palette reference preview')} />
            ) : (
              <span className="paletteUploadIcon" aria-hidden="true">◌</span>
            )}
            <span className="paletteUploadCopy">
              <strong>{paletteSourceName || ui('从图片提取色系', 'Extract palette from image')}</strong>
              <small>{ui('图片只在浏览器本地分析，不会上传', 'Images are analyzed locally and never uploaded')}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif"
              onChange={(event) => void handlePaletteImage(event.target.files?.[0])}
            />
          </label>

          <div className="paletteSwatches" aria-label={ui('当前提取色板', 'Extracted palette')}>
            {paletteSwatches.map((color, index) => (
              <span key={`${color}-${index}`} style={{ backgroundColor: color }} title={color} />
            ))}
          </div>
          <p className="paletteStatus">{paletteStatus}</p>

          <div className="presetGrid" aria-label={ui('颜色预设', 'Color presets')}>
            {palettePresets.map((palette) => (
              <PalettePresetButton
                key={palette.id}
                palette={palette}
                language={language}
                active={activePaletteId === palette.id}
                onClick={() => {
                  applyPalette(palette)
                  setPaletteStatus(ui(`已应用 ${palette.name} 预设`, `Applied the ${palette.name} preset`))
                }}
              />
            ))}
          </div>
        </section>

        <section className="panelGroup visualPanel" inert={isExporting}>
          <h2>{activeStyleTab === 'scene' ? ui('画面', 'Canvas') : activeStyleTab === 'lyrics' ? ui('歌词排版', 'Lyric layout') : ui('动效', 'Motion')}</h2>
          <label className="field canvasControl">
            <span>{ui('画幅', 'Canvas size')}</span>
            <select
              value={selectedSize}
              onChange={(event) => {
                const preset = presetSizes.find((item) => `${item.width}x${item.height}` === event.target.value)
                if (preset) {
                  setSettings((current) => ({ ...current, width: preset.width, height: preset.height }))
                }
              }}
            >
              {presetSizes.map((preset) => (
                <option key={preset.label} value={`${preset.width}x${preset.height}`}>{preset.label}</option>
              ))}
            </select>
          </label>

          <label className="field layoutControl">
            <span>{ui('音乐画面样式', 'Visualizer style')}</span>
            <select
              value={settings.visualStyle}
              onChange={(event) => selectVisualStyle(event.target.value as VisualizerSettings['visualStyle'])}
            >
              <option value="classic">{ui('普通滚动歌词', 'Classic scrolling lyrics')}</option>
              <option value="soda">{ui('汽水音乐卡片（无短视频侧栏）', 'Soda Music card')}</option>
              <option value="single">{ui('单句整行波动歌词（淡入淡出）', 'Fancy single-line wave')}</option>
              <option value="tiktok">{ui('TikTok 黑白逐词歌词（参考复刻）', 'TikTok monochrome word reveal')}</option>
            </select>
          </label>

          {settings.visualStyle === 'tiktok' ? (
            <p className="singleLyricNote">{ui('画面固定为 9:16 黑底，中间放置一个与画面同宽的白色正方形；上下黑边各占 21.875%，与参考视频的 720×1280 构图一致。', 'Uses a fixed 9:16 black canvas with a full-width white square centered vertically, matching the 720×1280 reference composition.')}</p>
          ) : <div className="backgroundControls">
            <label className="paletteUpload backgroundImageUpload">
              {backgroundImageUrl ? (
                <img src={backgroundImageUrl} alt={ui('自定义画面背景预览', 'Custom background preview')} />
              ) : (
                <span className="paletteUploadIcon" aria-hidden="true">▧</span>
              )}
              <span className="paletteUploadCopy">
                <strong>{backgroundImageName || ui('上传自定义图片背景', 'Upload a custom background')}</strong>
                <small>{backgroundFitDescription}</small>
              </span>
              <span className="fileAdd" aria-hidden="true">＋</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
                onChange={(event) => handleBackgroundImageFile(event.target.files?.[0])}
              />
            </label>

            <div className="backgroundImageTuning">
              <RangeField
                label={ui('图片高斯模糊', 'Background blur')}
                value={settings.backgroundImageBlur}
                min={0}
                max={80}
                unit="px"
                disabled={!backgroundImageUrl}
                onChange={(value) => updateSetting('backgroundImageBlur', value)}
              />
              <RangeField
                label={ui('图片变暗遮罩', 'Dark overlay')}
                value={settings.backgroundImageDarkness}
                min={0}
                max={90}
                unit="%"
                disabled={!backgroundImageUrl}
                onChange={(value) => updateSetting('backgroundImageDarkness', value)}
              />
            </div>

            {backgroundImageUrl && (
              <button className="backgroundImageClear" type="button" onClick={clearBackgroundImage}>
                {ui('移除自定义背景', 'Remove custom background')}
              </button>
            )}

            <div className="colorGrid">
              <ColorField label={ui('当前歌词', 'Current lyric')} value={settings.lyricColor} onChange={(value) => updateSetting('lyricColor', value)} />
              <ColorField label={ui('高亮最终颜色', 'Highlight color')} value={settings.progressColor} onChange={(value) => updateSetting('progressColor', value)} />
              <ColorField label={ui('其他歌词', 'Other lyrics')} value={settings.nextColor} onChange={(value) => updateSetting('nextColor', value)} />
              <ColorField label={ui('背景', 'Background')} value={settings.backgroundColor} onChange={(value) => updateSetting('backgroundColor', value)} disabled={settings.transparentBackground} />
            </div>
          </div>}

          <div className="lyricControls">
            {settings.visualStyle === 'single' ? (
              <p className="singleLyricNote">{ui('每次只显示一句歌词：字形沿整行水波起伏并柔软回弹。可开启入场变速，让新歌词先从上方快速波动，再自然减速为慢波。', 'Shows one lyric at a time with soft, line-wide glyph waves. Optional speed ramp makes each new line wave quickly from above, then settle into a slow motion.')}</p>
            ) : settings.visualStyle === 'tiktok' ? (
              <p className="singleLyricNote">{ui('每句歌词预先排版后按单词硬切显现，每屏最多三行，长句会自动切到下一组。增强 LRC 直接使用原逐词时间；普通 LRC 会在相邻两句之间自动分配时间。', 'Pre-layouts each lyric and reveals it word by word, up to three lines per screen. Enhanced LRC uses its word timing; regular LRC distributes timing between adjacent lines.')}</p>
            ) : (
              <>
            <div className="field highlightControl highlightModeControl">
              <span>{ui('当前歌词高亮', 'Current lyric highlight')}</span>
              <div className="highlightModeOptions" role="group" aria-label={ui('当前歌词高亮方式', 'Current lyric highlight mode')}>
                <button
                  className={settings.lyricHighlightMode === 'animated' ? 'active' : ''}
                  type="button"
                  aria-pressed={settings.lyricHighlightMode === 'animated'}
                  onClick={() => updateSetting('lyricHighlightMode', 'animated')}
                >
                  <span>{ui('变色动画', 'Color sweep')}</span>
                  <span className="highlightModeIndicator" aria-hidden="true" />
                </button>
                <button
                  className={settings.lyricHighlightMode === 'instant' ? 'active' : ''}
                  type="button"
                  aria-pressed={settings.lyricHighlightMode === 'instant'}
                  onClick={() => updateSetting('lyricHighlightMode', 'instant')}
                >
                  <span>{ui('直接显示', 'Instant')}</span>
                  <span className="highlightModeIndicator" aria-hidden="true" />
                </button>
                <button
                  className={settings.lyricHighlightMode === 'focus' ? 'active' : ''}
                  type="button"
                  aria-pressed={settings.lyricHighlightMode === 'focus'}
                  onClick={() => updateSetting('lyricHighlightMode', 'focus')}
                >
                  <span>{ui('浮入聚焦', 'Float into focus')}</span>
                  <span className="highlightModeIndicator" aria-hidden="true" />
                </button>
              </div>
            </div>

            <label className="field">
              <span>{ui('歌词对齐', 'Lyric alignment')}</span>
              <select
                value={settings.lyricAlignment}
                onChange={(event) => updateSetting('lyricAlignment', event.target.value as VisualizerSettings['lyricAlignment'])}
              >
                <option value="center">{ui('居中', 'Centered')}</option>
                <option value="left">{ui('向左对齐', 'Left aligned')}</option>
              </select>
            </label>

            <RangeField
              label={ui('歌词行距', 'Lyric line spacing')}
              value={settings.lineGap}
              min={64}
              max={180}
              unit="px"
              onChange={(value) => updateSetting('lineGap', value)}
            />

            <RangeField
              label={ui('显示歌词行数', 'Visible lyric lines')}
              value={settings.visibleLineCount}
              min={3}
              max={13}
              unit={ui('行', 'lines')}
              onChange={(value) => updateSetting('visibleLineCount', value)}
            />
              </>
            )}
          </div>

          <div className="motionControls">
            <div className="toggleList">
              <ToggleField
                label={ui('透明背景', 'Transparent background')}
                checked={settings.transparentBackground}
                disabled={settings.visualStyle === 'tiktok'}
                onChange={(checked) => updateSetting('transparentBackground', checked)}
              />
              <ToggleField
                label={ui('显示歌曲信息', 'Show song details')}
                checked={settings.showMetadata}
                disabled={settings.visualStyle === 'single' || settings.visualStyle === 'tiktok'}
                onChange={(checked) => updateSetting('showMetadata', checked)}
              />
              <ToggleField
                label={ui('显示底部线型进度条', 'Show bottom progress line')}
                checked={settings.showProgressBar}
                disabled={settings.visualStyle === 'single' || settings.visualStyle === 'tiktok'}
                onChange={(checked) => updateSetting('showProgressBar', checked)}
              />
              <ToggleField
                label={ui('歌词入场先快后慢', 'Fast-to-slow lyric entrance')}
                checked={settings.singleWaveSpeedRamp}
                disabled={settings.visualStyle !== 'single'}
                onChange={(checked) => updateSetting('singleWaveSpeedRamp', checked)}
              />
              <ToggleField
                label={ui('显示底部鼓点律动条', 'Show beat-reactive bar')}
                checked={settings.showBeatBar}
                disabled={settings.visualStyle === 'tiktok'}
                onChange={(checked) => updateSetting('showBeatBar', checked)}
              />
            </div>
            {settings.showBeatBar && <p className="singleLyricNote">{beatAnalysisStatus}</p>}
          </div>
        </section>

        <section className="panelGroup exportGroup">
          <div className="sectionTitleRow">
            <h2>{ui('导出', 'Export')}</h2>
            <span>{exportBadge}</span>
          </div>
          <div className="exportRangeMode" role="group" aria-label={ui('导出范围', 'Export range')}>
            <button
              className={exportRangeMode === 'full' ? 'active' : ''}
              type="button"
              disabled={isExporting}
              aria-pressed={exportRangeMode === 'full'}
              onClick={() => setExportRangeMode('full')}
            >
              {ui('完整音频', 'Full audio')}
            </button>
            <button
              className={exportRangeMode === 'selection' ? 'active' : ''}
              type="button"
              disabled={isExporting}
              aria-pressed={exportRangeMode === 'selection'}
              onClick={() => setExportRangeMode('selection')}
            >
              {ui('选定片段', 'Selected range')}
            </button>
          </div>
          {exportRangeMode === 'selection' && (
            <div className={hasValidSelection ? 'clipEditor' : 'clipEditor invalid'}>
              <div className="clipSummary">
                <span>{formatTimePrecise(exportStartTime)} – {formatTimePrecise(exportEndTime)}</span>
                <strong>{ui(`时长 ${formatTimePrecise(selectedRangeDuration)}`, `Duration ${formatTimePrecise(selectedRangeDuration)}`)}</strong>
              </div>
              <div className="clipRangeField">
                <span className="clipRangeHeader">
                  <span>{ui('开始点', 'Start')}</span>
                  <button type="button" disabled={isExporting} onClick={() => updateExportStartTime(currentTimeRef.current)}>{ui('使用当前位置', 'Use playhead')}</button>
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.1, audioDuration)}
                  step={0.1}
                  value={clampNumber(exportStartTime, 0, audioDuration)}
                  disabled={isExporting}
                  aria-label={ui('导出片段开始点', 'Export range start')}
                  onChange={(event) => updateExportStartTime(Number(event.target.value))}
                />
              </div>
              <div className="clipRangeField">
                <span className="clipRangeHeader">
                  <span>{ui('结束点', 'End')}</span>
                  <button type="button" disabled={isExporting} onClick={() => updateExportEndTime(currentTimeRef.current)}>{ui('使用当前位置', 'Use playhead')}</button>
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(minimumExportDuration, audioDuration)}
                  step={0.1}
                  value={clampNumber(exportEndTime, 0, audioDuration)}
                  disabled={isExporting}
                  aria-label={ui('导出片段结束点', 'Export range end')}
                  onChange={(event) => updateExportEndTime(Number(event.target.value))}
                />
              </div>
              <div className="clipSeekActions">
                <button type="button" disabled={isExporting} onClick={() => seekTo(exportStartTime)}>{ui('跳到开始', 'Go to start')}</button>
                <button type="button" disabled={isExporting} onClick={() => seekTo(exportEndTime)}>{ui('跳到结束', 'Go to end')}</button>
              </div>
              {!hasValidSelection && <p className="clipError">{ui('结束点必须晚于开始点至少 0.1 秒', 'The end must be at least 0.1 seconds after the start')}</p>}
            </div>
          )}
          <button
            className="primaryButton"
            type="button"
            onClick={() => void startExport()}
            disabled={isExporting || fastExportSupport === null || !fastExportSupport.supported || !hasValidSelection}
          >
            <span aria-hidden="true">↓</span>
            {exportButtonLabel}
          </button>
          {settings.visualStyle === 'tiktok' && (
            <div className="tiktokFrameExport">
              <div className="tiktokFrameExportHeader">
                <div>
                  <strong>{ui('逐词 PNG 序列', 'Word-by-word PNG sequence')}</strong>
                  <p>{ui('片段起始状态与每次新增词都会生成一张完整图片，统一打包为 ZIP。', 'Creates a full PNG for the initial state and every newly revealed word, then packages them as a ZIP.')}</p>
                </div>
                <span>{ui(`${tiktokFrameCount} 张`, `${tiktokFrameCount} frames`)}</span>
              </div>
              <button
                className="tiktokFrameExportButton"
                type="button"
                onClick={() => void startTikTokFrameExport()}
                disabled={isExporting || !hasValidSelection || tiktokFrameCount === 0}
              >
                <span aria-hidden="true">▣</span>
                {isExporting ? ui(`正在生成 ${Math.round(exportProgress * 100)}%`, `Generating ${Math.round(exportProgress * 100)}%`) : ui('导出逐词 PNG（ZIP）', 'Export word PNGs (ZIP)')}
              </button>
            </div>
          )}
          <div className="meter" aria-label={ui('导出进度', 'Export progress')}>
            <span style={{ width: `${Math.round(exportProgress * 100)}%` }} />
          </div>
          <p className="statusLine">{exportStatus}</p>
          {settings.transparentBackground && (
            <p className="statusLine">{ui('透明导出将生成 VP9 Alpha WebM；若浏览器编码器不支持透明通道，导出会明确报错，不会生成不透明视频。', 'Transparent export creates a VP9 Alpha WebM. If the browser encoder cannot preserve alpha, export fails visibly instead of producing an opaque video.')}</p>
          )}
          {fastExportSupport?.supported && (
            <p className="statusLine">{ui('画面与音频均直接编码，不使用 MediaRecorder 或预览录制；切换窗口不会影响成片。', 'Video and audio are encoded directly without MediaRecorder or preview capture, so switching windows does not affect the export.')}</p>
          )}
          {fastExportSupport && !fastExportSupport.supported && (
            <p className="statusLine">{fastExportSupport.reason}</p>
          )}
          {exportResult && (
            <a className="downloadButton" href={exportResult.url} download={exportResult.filename}>
              <span aria-hidden="true">↓</span>
              {ui('下载', 'Download')} {exportResult.filename.endsWith('.mp4') ? 'MP4' : 'WebM'}
            </a>
          )}
          {frameSequenceResult && settings.visualStyle === 'tiktok' && (
            <a className="downloadButton" href={frameSequenceResult.url} download={frameSequenceResult.filename}>
              <span aria-hidden="true">↓</span>
              {ui(`下载逐词 PNG 序列（${frameSequenceResult.frameCount} 张）`, `Download word PNG sequence (${frameSequenceResult.frameCount} frames)`)}
            </a>
          )}
        </section>
        </aside>
      </section>

      {isPasteLyricsOpen && (
        <div className="pasteLyricsBackdrop" role="presentation">
          <section className="pasteLyricsDialog" role="dialog" aria-modal="true" aria-labelledby="pasteLyricsTitle">
            <header>
              <div>
                <span>{ui('纯文本歌词', 'Plain-text lyrics')}</span>
                <h2 id="pasteLyricsTitle">{ui('粘贴歌词并开始打轴', 'Paste lyrics and add timing')}</h2>
                <p>{ui('每一行会成为一句歌词；空行会自动忽略。', 'Each line becomes one lyric line; blank lines are ignored.')}</p>
              </div>
              <button type="button" aria-label={ui('关闭粘贴歌词窗口', 'Close paste lyrics dialog')} onClick={() => setIsPasteLyricsOpen(false)}>×</button>
            </header>
            <textarea
              autoFocus
              value={pastedLyricsText}
              placeholder={ui('把歌词粘贴到这里，例如：\n第一句歌词\n第二句歌词\n第三句歌词', 'Paste lyrics here, for example:\nFirst lyric line\nSecond lyric line\nThird lyric line')}
              onChange={(event) => {
                setPastedLyricsText(event.target.value)
                if (pasteLyricsError) setPasteLyricsError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  startTimingPastedLyrics()
                }
              }}
            />
            <footer>
              <div>
                <strong>{ui(`${parsePlainTextLyrics(pastedLyricsText).length} 行歌词`, `${parsePlainTextLyrics(pastedLyricsText).length} lyric lines`)}</strong>
                <span className={pasteLyricsError ? 'pasteLyricsError' : ''}>{pasteLyricsError || ui('⌘/Ctrl + Enter 可直接进入打轴器', '⌘/Ctrl + Enter opens the timing editor')}</span>
              </div>
              <div>
                <button type="button" onClick={() => setIsPasteLyricsOpen(false)}>{ui('取消', 'Cancel')}</button>
                <button className="pasteLyricsStartButton" type="button" disabled={parsePlainTextLyrics(pastedLyricsText).length === 0} onClick={startTimingPastedLyrics}>{ui('进入打轴器', 'Open timing editor')}</button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {timingEditorSource && (
        <TimingEditor
          key={`${timingEditorSource.name}-${timingEditorSource.lines.length}`}
          audioUrl={audioUrl}
          audioFile={audioFileRef.current}
          audioDuration={audioDuration}
          sourceName={timingEditorSource.name}
          metadata={timingEditorSource.metadata}
          initialLines={timingEditorSource.lines}
          language={language}
          onCancel={() => setTimingEditorSource(null)}
          onApply={applyTimedLyrics}
        />
      )}
    </main>
  )
}

function PalettePresetButton(props: {
  palette: VisualizerPalette
  language: UiLanguage
  active: boolean
  onClick: () => void
}) {
  const previewStyle = {
    background: `linear-gradient(135deg, ${props.palette.backgroundColor} 0 52%, ${props.palette.progressColor} 52% 74%, ${props.palette.lyricColor} 74%)`,
  }

  return (
    <button
      className={props.active ? 'palettePreset active' : 'palettePreset'}
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      <span className="palettePresetPreview" style={previewStyle} aria-hidden="true" />
      <span className="palettePresetCopy">
        <strong>{props.palette.name}</strong>
        <small>{pickUiText(props.language, props.palette.description, props.palette.descriptionEn ?? props.palette.description)}</small>
      </span>
    </button>
  )
}

function ColorField(props: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label className="colorField">
      <span>{props.label}</span>
      <span className="colorWell" style={{ '--swatch-color': props.value } as CSSProperties}>
        <input type="color" value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} />
      </span>
    </label>
  )
}

function RangeField(props: {
  label: string
  value: number
  min: number
  max: number
  unit: string
  disabled?: boolean
  onChange: (value: number) => void
}) {
  const numericValue = Math.round(props.value)
  return (
    <label className={props.disabled ? 'rangeField isDisabled' : 'rangeField'}>
      <span className="rangeHeader">
        <span>{props.label}</span>
        <span className="rangeValueInput">
          <input
            type="number"
            min={props.min}
            max={props.max}
            value={numericValue}
            disabled={props.disabled}
            aria-label={props.label}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value)) {
                props.onChange(clampNumber(value, props.min, props.max))
              }
            }}
          />
          <span>{props.unit}</span>
        </span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  )
}

function ToggleField(props: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggleField">
      <span>{props.label}</span>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      <span className="switchTrack" aria-hidden="true"><span /></span>
    </label>
  )
}

function quoteFontFamily(family: string): string {
  return `"${family.replaceAll('"', '')}"`
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function formatTime(value: number): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const minutes = Math.floor(safeValue / 60)
  const seconds = Math.floor(safeValue % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatTimePrecise(value: number): string {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const minutes = Math.floor(safeValue / 60)
  const seconds = Math.floor(safeValue % 60)
  const tenths = Math.floor((safeValue % 1) * 10)
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${tenths}`
}

function formatAspectRatio(width: number, height: number): string {
  const divisor = greatestCommonDivisor(Math.round(width), Math.round(height))
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`
}

function resolveTextElementSettingKey(element: TextElement): 'fontSize' | 'metadataTitleFontSize' | 'metadataArtistFontSize' | 'sodaBrandFontSize' | 'sodaPlaylistFontSize' {
  switch (element) {
    case 'currentLyric':
    case 'normalLyric':
      return 'fontSize'
    case 'title':
      return 'metadataTitleFontSize'
    case 'artist':
      return 'metadataArtistFontSize'
    case 'brand':
      return 'sodaBrandFontSize'
    case 'playlist':
      return 'sodaPlaylistFontSize'
  }
}

function resolveTextElementColorKey(element: TextElement): 'lyricColor' | 'nextColor' | 'metaColor' {
  if (element === 'currentLyric') return 'lyricColor'
  if (element === 'normalLyric') return 'nextColor'
  return 'metaColor'
}

function resolveTextElementSize(settings: VisualizerSettings, element: TextElement): number {
  return settings[resolveTextElementSettingKey(element)]
}

function resolveTextElementColor(settings: VisualizerSettings, element: TextElement): string {
  return settings[resolveTextElementColorKey(element)]
}

function getTextElementRange(element: TextElement): { min: number; max: number } {
  switch (element) {
    case 'currentLyric':
    case 'normalLyric':
      return { min: 36, max: 200 }
    case 'title':
      return { min: 24, max: 72 }
    case 'artist':
      return { min: 18, max: 56 }
    case 'brand':
      return { min: 24, max: 72 }
    case 'playlist':
      return { min: 20, max: 64 }
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let first = Math.max(1, Math.abs(left))
  let second = Math.max(1, Math.abs(right))

  while (second !== 0) {
    const remainder = first % second
    first = second
    second = remainder
  }

  return first
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getPreviewRenderScale(settings: VisualizerSettings): number {
  return Math.min(1, 1280 / settings.width, 720 / settings.height)
}

function isMatchingAspectRatio(
  imageSize: { width: number; height: number },
  settings: Pick<VisualizerSettings, 'width' | 'height'>,
): boolean {
  if (imageSize.width <= 0 || imageSize.height <= 0 || settings.width <= 0 || settings.height <= 0) {
    return false
  }

  const imageRatio = imageSize.width / imageSize.height
  const targetRatio = settings.width / settings.height
  return Math.abs(imageRatio - targetRatio) / targetRatio < 0.012
}

function hexToRgbChannels(color: string): string {
  const normalized = color.replace('#', '').padEnd(6, '0').slice(0, 6)
  return [0, 2, 4]
    .map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16))
    .join(' ')
}

export default App
