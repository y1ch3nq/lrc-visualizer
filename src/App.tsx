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
  const [fontStatus, setFontStatus] = useState('未导入字体')
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
  const [exportStatus, setExportStatus] = useState('等待导出')
  const [isExporting, setIsExporting] = useState(false)
  const [exportRangeMode, setExportRangeMode] = useState<ExportRangeMode>('full')
  const [exportStartTime, setExportStartTime] = useState(0)
  const [exportEndTime, setExportEndTime] = useState(27)
  const [fastExportSupport, setFastExportSupport] = useState<FastExportSupport | null>(null)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)
  const [frameSequenceResult, setFrameSequenceResult] = useState<TikTokFrameExportResult | null>(null)
  const [paletteImageUrl, setPaletteImageUrl] = useState('')
  const [paletteSourceName, setPaletteSourceName] = useState('')
  const [paletteStatus, setPaletteStatus] = useState('上传画面截图，自动生成协调的歌词颜色')
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
  const [saveStatus, setSaveStatus] = useState('正在保存')
  const [isPromoExpanded, setIsPromoExpanded] = useState(false)
  const [sodaBrandText, setSodaBrandText] = useState('汽水音乐 · 抖音官方音乐App')
  const [sodaPlaylistText, setSodaPlaylistText] = useState('查看我的今日歌单')
  const [previewCanvasSize, setPreviewCanvasSize] = useState({ width: 0, height: 0 })
  const [audioAnalysisVersion, setAudioAnalysisVersion] = useState(0)
  const [beatAnalysisStatus, setBeatAnalysisStatus] = useState('导入音频后分析低频鼓点')
  const [timingEditorSource, setTimingEditorSource] = useState<TimingEditorSource | null>(null)
  const [isPasteLyricsOpen, setIsPasteLyricsOpen] = useState(false)
  const [pastedLyricsText, setPastedLyricsText] = useState('')
  const [pasteLyricsError, setPasteLyricsError] = useState('')
  const [isAligningLyrics, setIsAligningLyrics] = useState(false)

  const title = songTitle.trim() || parsedLrc.metadata.ti || parsedLrc.metadata.title || stripExtension(lrcFileName || audioFileName)
  const artist = songArtist.trim() || parsedLrc.metadata.ar || parsedLrc.metadata.artist || ''
  const fontOptions = useMemo(
    () => [
      { label: '系统中文', value: chineseSystemFont },
      { label: '系统英文', value: englishSystemFont },
      { label: 'Arial Narrow（TikTok 参考）', value: tiktokReferenceFont },
      ...importedFonts.map((font) => ({ label: font.name, value: quoteFontFamily(font.family) })),
    ],
    [importedFonts],
  )
  const activeTextElementLabel = {
    currentLyric: '当前歌词',
    normalLyric: '普通歌词',
    title: '歌名',
    artist: '歌手',
    brand: '顶部宣传栏',
    playlist: '歌单入口',
  }[activeTextElement]
  const activeTextSize = resolveTextElementSize(settings, activeTextElement)
  const activeTextColor = resolveTextElementColor(settings, activeTextElement)
  const backgroundFitDescription = backgroundImageSize
    ? `${backgroundImageSize.width}×${backgroundImageSize.height} · ${isMatchingAspectRatio(backgroundImageSize, settings)
      ? `匹配当前 ${formatAspectRatio(settings.width, settings.height)} 画幅`
      : `将自动居中裁切为 ${formatAspectRatio(settings.width, settings.height)}`}`
    : '建议上传与输出画幅相同比例的图片；其他比例会自动居中裁切'

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
      setSaveStatus('已恢复上次编辑')
    } catch {
      setSaveStatus('实时预览')
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
        setSaveStatus('已自动保存')
      } catch {
        setSaveStatus('实时预览')
      }
    }, 420)

    return () => window.clearTimeout(timer)
  }, [settings, sodaBrandText, sodaPlaylistText, songArtist, songTitle])

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

    setPaletteStatus('正在进行感知色彩分析…')

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
      setPaletteStatus(`已从 ${file.name} 提取 ${result.swatches.length} 个主色，并自动匹配歌词层级`)
    } catch (error) {
      setPaletteStatus(error instanceof Error ? error.message : '图片配色分析失败')
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
      setExportStatus('当前浏览器无法进入全屏预览')
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
    setBeatAnalysisStatus('正在分析低频鼓点…')
    setAudioUrl(url)
    setAudioFileName(file.name)
    setSongTitle(stripExtension(file.name))
    setSongArtist('')
    setExportStatus('音频已载入')
    currentTimeRef.current = 0
    setExportRangeMode('full')
    setExportStartTime(0)

    void analyzeAudioFile(file).then((envelope) => {
      if (audioUrlRef.current !== url) {
        return
      }

      audioReactiveEnvelopeRef.current = envelope
      setAudioAnalysisVersion((version) => version + 1)
      setBeatAnalysisStatus('鼓点分析完成，预览与导出将保持同步')
    }).catch(() => {
      if (audioUrlRef.current === url) {
        audioReactiveEnvelopeRef.current = null
        setAudioAnalysisVersion((version) => version + 1)
        setBeatAnalysisStatus('未能分析鼓点，律动条将保持静止')
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
        setExportStatus('音频已载入 · 已读取内嵌标题、歌手或封面')
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
      setExportStatus(`歌词已载入：${parsed.lines.length} 行`)
      currentTimeRef.current = 0

      if (audioRef.current) {
        audioRef.current.currentTime = 0
      }
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : 'LRC 文件读取失败')
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
        setExportStatus('TXT 中没有可用的歌词行')
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
      setExportStatus(`已读取 ${textLines.length} 行纯文本歌词，请在打轴器中标记时间`)
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : 'TXT 文件读取失败')
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
      setPasteLyricsError('请至少粘贴一行歌词。')
      return
    }

    openTimingEditor({
      name: '粘贴歌词.txt',
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
    setExportStatus(`已读取 ${textLines.length} 行粘贴歌词，请在打轴器中标记时间`)
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
    setExportStatus(`打轴已应用：${lines.length} 行${lines.some((line) => line.endTime !== undefined) ? ' · 含独立句尾' : ''}`)
  }

  const alignCurrentLyricsLocally = async () => {
    const audioFile = audioFileRef.current
    if (!audioFile) {
      setExportStatus('请先导入音频，再运行本地逐词对齐')
      return
    }
    if (parsedLrc.lines.length === 0) {
      setExportStatus('请先导入或打轴歌词')
      return
    }

    audioRef.current?.pause()
    setIsAligningLyrics(true)
    setExportStatus('正在浏览器内分析声音起点并生成逐词时间…')
    try {
      const result = await alignLyricsToAudio(audioFile, parsedLrc.lines, audioDuration)
      setParsedLrc((current) => ({ ...current, lines: result.lines }))
      setExportStatus(`本地逐词对齐完成：${result.alignedLineCount} 句 · 参考置信度 ${Math.round(result.confidence * 100)}%`)
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : '本地逐词对齐失败')
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
      setFontStatus(`已导入：${file.name}`)
    } catch {
      setFontStatus('字体导入失败，请确认是 ttf/otf/woff/woff2')
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
      setExportStatus('请先导入音频')
      return
    }

    if (parsedLrc.lines.length === 0) {
      setExportStatus('请先导入 LRC 歌词')
      return
    }

    const rangeStart = exportRangeMode === 'selection'
      ? clampNumber(exportStartTime, 0, audioDuration)
      : 0
    const rangeEnd = exportRangeMode === 'selection'
      ? clampNumber(exportEndTime, 0, audioDuration)
      : audioDuration

    if (rangeEnd - rangeStart < minimumExportDuration) {
      setExportStatus('结束点必须晚于开始点至少 0.1 秒')
      return
    }

    const support = await getDirectExportSupport(settings)
    setFastExportSupport(support)
    if (!support.supported) {
      setExportStatus(support.reason ?? '当前浏览器不支持直接导出')
      return
    }

    audioRef.current?.pause()

    setIsExporting(true)
    setExportProgress(0)
    setExportCurrentTime(rangeStart)
    setExportResult(null)
    setExportStatus(`正在离屏编码 ${support.format ?? '视频'} ${formatTimePrecise(rangeStart)}–${formatTimePrecise(rangeEnd)}`)

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
      setExportStatus(`${result.mimeType === 'video/mp4' ? 'MP4' : 'WebM'} 已直接生成`)

      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current)
      }

      resultUrlRef.current = result.url
      setExportResult(result)
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : '导出失败')
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
      setExportStatus('请先导入带时间轴的歌词')
      return
    }

    const rangeStart = exportRangeMode === 'selection'
      ? clampNumber(exportStartTime, 0, audioDuration)
      : 0
    const rangeEnd = exportRangeMode === 'selection'
      ? clampNumber(exportEndTime, 0, audioDuration)
      : audioDuration

    if (rangeEnd - rangeStart < minimumExportDuration) {
      setExportStatus('结束点必须晚于开始点至少 0.1 秒')
      return
    }

    audioRef.current?.pause()
    setIsExporting(true)
    setExportProgress(0)
    setExportCurrentTime(rangeStart)
    setExportStatus('正在生成逐词 PNG 序列…')

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
          setExportStatus(`正在生成逐词 PNG ${Math.round(progress * 100)}%（${frameCount} 张）`)
        },
      })

      if (frameSequenceUrlRef.current) {
        URL.revokeObjectURL(frameSequenceUrlRef.current)
      }

      frameSequenceUrlRef.current = result.url
      setFrameSequenceResult(result)
      setExportStatus(`已生成 ${result.frameCount} 张 PNG，并打包为 ZIP`)
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : '逐词 PNG 导出失败')
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
    ? '检测中'
    : fastExportSupport.supported
      ? `DIRECT ${fastExportSupport.format ?? 'VIDEO'}`
      : '不可用'
  const exportButtonLabel = isExporting
    ? `正在导出 ${Math.round(exportProgress * 100)}%`
    : exportRangeMode === 'selection' ? '直接导出选定片段' : '直接导出完整视频'
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
        <span className="projectName" title={title || '未命名项目'}>{title || '未命名项目'}</span>
        <div className="headerActions">
          <span className="autosaveStatus">{saveStatus}</span>
          <button
            className="previewHeaderButton"
            type="button"
            onClick={() => void togglePreviewFullscreen()}
          >
            预览
          </button>
          <button
            className="headerExportButton"
            type="button"
            disabled={isExporting || fastExportSupport === null || !fastExportSupport.supported || !hasValidSelection}
            onClick={() => void startExport()}
          >
            {isExporting ? `导出 ${Math.round(exportProgress * 100)}%` : '导出视频'}
          </button>
        </div>
      </header>

      <section className="editorGrid">
        <aside className="projectSidebar" aria-label="项目素材">
          <section className="sidebarSection projectSection" inert={isExporting}>
            <div className="sidebarTitleRow">
              <h2>项目</h2>
              <span>素材与内容</span>
            </div>

            <label className={audioFileName ? 'compactFileRow isReady' : 'compactFileRow'}>
              <span className="assetState" aria-hidden="true">{audioFileName ? '✓' : '♪'}</span>
              <span className="assetCopy">
                <strong>音频</strong>
                <small>{audioFileName || '导入音频文件'}</small>
              </span>
              <span className="assetAction">{audioFileName ? '替换' : '添加'}</span>
              <input type="file" accept="audio/*" onChange={(event) => handleAudioFile(event.target.files?.[0])} />
            </label>

            <div className="lyricsImportBlock">
              <label className={lrcFileName ? 'compactFileRow isReady' : 'compactFileRow'}>
                <span className="assetState assetStateLrc" aria-hidden="true">{lrcFileName ? '✓' : 'LRC'}</span>
                <span className="assetCopy">
                  <strong>带时间 LRC</strong>
                  <small>{lrcFileName || '直接导入已有时间轴'}</small>
                </span>
                <span className="assetAction">{lrcFileName ? '替换' : '导入'}</span>
                <input type="file" accept=".lrc" onChange={(event) => void handleLrcFile(event.target.files?.[0])} />
              </label>

              <label className="compactFileRow compactFileRowSecondary">
                <span className="assetState assetStateTxt" aria-hidden="true">TXT</span>
                <span className="assetCopy">
                  <strong>纯 TXT → 打轴器</strong>
                  <small>逐句标记句首与独立句尾</small>
                </span>
                <span className="assetAction">打轴</span>
                <input type="file" accept=".txt,text/plain" onChange={(event) => void handleTxtFile(event.target.files?.[0])} />
              </label>

              <button className="pasteLyricsTrigger" type="button" disabled={isExporting} onClick={openPasteLyricsDialog}>
                <span aria-hidden="true">＋</span>
                <span><strong>直接粘贴歌词</strong><small>无需保存 TXT，按换行自动拆句</small></span>
                <span aria-hidden="true">粘贴</span>
              </button>

              <div className="lyricToolActions">
                <button type="button" disabled={parsedLrc.lines.length === 0 || isExporting} onClick={openCurrentLyricsInTimingEditor}>打开打轴器</button>
                <button type="button" disabled={!audioFileName || parsedLrc.lines.length === 0 || isAligningLyrics || isExporting} onClick={() => void alignCurrentLyricsLocally()}>
                  {isAligningLyrics ? '对齐中…' : '本地逐词对齐'}
                </button>
              </div>
            </div>

            <label className={coverUrl ? 'compactFileRow isReady' : 'compactFileRow'}>
              {coverUrl ? <img src={coverUrl} alt="当前专辑封面" className="coverInputPreview" /> : <span className="assetState" aria-hidden="true">▣</span>}
              <span className="assetCopy">
                <strong>专辑封面</strong>
                <small>{coverName || '可从 MP3 读取或手动添加'}</small>
              </span>
              <span className="assetAction">{coverUrl ? '替换' : '添加'}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleCoverFile(event.target.files?.[0])} />
            </label>

            <label className={backgroundImageUrl ? 'compactFileRow isReady' : 'compactFileRow'}>
              {backgroundImageUrl ? <img src={backgroundImageUrl} alt="当前自定义背景" className="coverInputPreview" /> : <span className="assetState" aria-hidden="true">▧</span>}
              <span className="assetCopy">
                <strong>画面背景</strong>
                <small>{backgroundImageName || '上传图片，自动适配当前画幅'}</small>
              </span>
              <span className="assetAction">{backgroundImageUrl ? '替换' : '添加'}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleBackgroundImageFile(event.target.files?.[0])} />
            </label>

            <div className="sidebarSubheading">歌曲信息</div>
            <label className={activeTextElement === 'title' ? 'compactTextField active' : 'compactTextField'}>
              <span>歌名</span>
              <input
                type="text"
                value={songTitle}
                placeholder={stripExtension(lrcFileName || audioFileName) || '输入歌名'}
                onFocus={() => setActiveTextElement('title')}
                onChange={(event) => setSongTitle(event.target.value)}
              />
            </label>
            <label className={activeTextElement === 'artist' ? 'compactTextField active' : 'compactTextField'}>
              <span>歌手</span>
              <input
                type="text"
                value={songArtist}
                placeholder="输入歌手名"
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
              宣传文案与歌单入口
            </button>
            {isPromoExpanded && (
              <div className="promoFields">
                <label className={activeTextElement === 'brand' ? 'compactTextField active' : 'compactTextField'}>
                  <span>顶部宣传栏</span>
                  <input type="text" value={sodaBrandText} onFocus={() => setActiveTextElement('brand')} onChange={(event) => setSodaBrandText(event.target.value)} />
                </label>
                <label className={activeTextElement === 'playlist' ? 'compactTextField active' : 'compactTextField'}>
                  <span>歌单入口</span>
                  <input type="text" value={sodaPlaylistText} onFocus={() => setActiveTextElement('playlist')} onChange={(event) => setSodaPlaylistText(event.target.value)} />
                </label>
                <label className={brandIconUrl ? 'compactFileRow isReady compactBrandIconRow' : 'compactFileRow compactBrandIconRow'}>
                  {brandIconUrl ? <img src={brandIconUrl} alt="当前顶部图标" className="coverInputPreview" /> : <span className="assetState" aria-hidden="true">♪</span>}
                  <span className="assetCopy">
                    <strong>顶部图标</strong>
                    <small>{brandIconName || '默认音乐图标，可上传替换'}</small>
                  </span>
                  <span className="assetAction">{brandIconUrl ? '替换' : '添加'}</span>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleBrandIconFile(event.target.files?.[0])} />
                </label>
              </div>
            )}
          </section>
        </aside>

      <section className="workspace">
        <section className="previewPanel">
          <div className="previewToolbar">
            <span className="previewLabel">适应窗口</span>
            <span className="previewScale">{Math.round(getPreviewRenderScale(settings) * 100)}%</span>
            <span className="formatBadge">{formatAspectRatio(settings.width, settings.height)}</span>
            <button
              className="previewFullscreenButton toolbarFullscreenButton"
              type="button"
              onClick={() => void togglePreviewFullscreen()}
              aria-label={isPreviewFullscreen ? '退出全屏预览' : '全屏预览'}
              title={isPreviewFullscreen ? '退出全屏预览' : '全屏预览'}
            >
              <span aria-hidden="true">⤢</span>
            </button>
          </div>
          <div ref={canvasShellRef} className={settings.transparentBackground ? 'canvasShell transparent' : 'canvasShell'}>
            <canvas
              ref={canvasRef}
              style={canvasStyle}
              data-orientation={settings.height > settings.width ? 'portrait' : settings.width > settings.height ? 'landscape' : 'square'}
              aria-label={`${formatAspectRatio(settings.width, settings.height)} 歌词可视化预览`}
            />
            {isExporting && <span className="recordingBadge">EXPORT · 正在离屏逐帧编码</span>}
          </div>
          <div className="transport">
            <div className="transportControls">
              <button className="jumpButton" type="button" onClick={() => seekBy(-5)} disabled={isExporting} title="后退 5 秒">
                <span aria-hidden="true">−5</span>
                <span className="srOnly">后退 5 秒</span>
              </button>
              <button className="playButton" type="button" onClick={togglePlayback} disabled={!audioUrl || isExporting} title={isPlaying ? '暂停' : '播放'}>
                <span aria-hidden="true">{isPlaying ? 'Ⅱ' : '▶'}</span>
                <span className="srOnly">{isPlaying ? '暂停' : '播放'}</span>
              </button>
              <button className="jumpButton" type="button" onClick={() => seekBy(5)} disabled={isExporting} title="快进 5 秒">
                <span aria-hidden="true">+5</span>
                <span className="srOnly">快进 5 秒</span>
              </button>
            </div>
            <div className="transportTimeline">
              <div className="transportMeta">
                <strong>{title || '未命名作品'}</strong>
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
                aria-label="预览播放进度"
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
          <p>实时预览使用性能分辨率保证滚动流畅；导出仍按所选画幅的完整分辨率逐帧生成。</p>
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
            <p>编辑器</p>
            <strong>画面设置</strong>
          </div>
          <div className="panelHeadingActions">
            <span className="autosaveStatus">实时预览</span>
            <button
              className="headerExportButton"
              type="button"
              disabled={isExporting || fastExportSupport === null || !fastExportSupport.supported || !hasValidSelection}
              onClick={() => void startExport()}
            >
              导出视频
            </button>
            <span className="readyMark" title="实时预览已连接" aria-label="实时预览已连接" />
          </div>
        </div>

        <div className="styleTabs" role="tablist" aria-label="样式设置分组">
          {([
            ['scene', '画面与背景'],
            ['lyrics', '歌词与文字'],
            ['typeMotion', '字体与动效'],
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
          <h2>项目素材</h2>
          <label className="fileInput">
            <span className="fileIcon" aria-hidden="true">♪</span>
            <span className="fileCopy">
              <strong>导入音频文件</strong>
              <small>{audioFileName || '支持 MP3 / WAV / M4A 等格式'}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept="audio/*" onChange={(event) => handleAudioFile(event.target.files?.[0])} />
          </label>

          <label className="fileInput">
            <span className="fileIcon fileIconText" aria-hidden="true">LRC</span>
            <span className="fileCopy">
              <strong>导入 LRC 歌词</strong>
              <small>{lrcFileName ? `${lrcFileName}${lrcEncoding ? ` · ${lrcEncoding}` : ''}` : '自动识别 UTF-8、GBK、Big5 与 UTF-16'}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept=".lrc" onChange={(event) => void handleLrcFile(event.target.files?.[0])} />
          </label>

          <label className="fileInput">
            <span className="fileIcon fileIconText" aria-hidden="true">TXT</span>
            <span className="fileCopy">
              <strong>导入纯 TXT 并打轴</strong>
              <small>在内置打轴器中分别设置句首和句尾</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept=".txt,text/plain" onChange={(event) => void handleTxtFile(event.target.files?.[0])} />
          </label>

          <button className="pasteLyricsTrigger pasteLyricsTriggerWide" type="button" disabled={isExporting} onClick={openPasteLyricsDialog}>
            <span aria-hidden="true">＋</span>
            <span><strong>直接粘贴歌词</strong><small>把多行歌词粘贴进文本框后直接开始打轴</small></span>
            <span aria-hidden="true">粘贴</span>
          </button>

          <div className="metadataEditor">
            <label className="field">
              <span>歌名（画面左上角）</span>
              <input
                type="text"
                value={songTitle}
                placeholder={stripExtension(lrcFileName || audioFileName) || '输入歌名'}
                onChange={(event) => setSongTitle(event.target.value)}
              />
            </label>
            <label className="field">
              <span>歌手</span>
              <input
                type="text"
                value={songArtist}
                placeholder="输入歌手名"
                onChange={(event) => setSongArtist(event.target.value)}
              />
            </label>
          </div>

          <div className="sodaPromoEditor">
            <p>汽水音乐样式文案</p>
            <label className="field">
              <span>顶部宣传栏</span>
              <input
                type="text"
                value={sodaBrandText}
                onChange={(event) => setSodaBrandText(event.target.value)}
              />
            </label>
            <label className="field">
              <span>歌单入口</span>
              <input
                type="text"
                value={sodaPlaylistText}
                onChange={(event) => setSodaPlaylistText(event.target.value)}
              />
            </label>
          </div>

          <label className="fileInput coverInput">
            {coverUrl ? (
              <img src={coverUrl} alt="当前专辑封面" className="coverInputPreview" />
            ) : (
              <span className="fileIcon coverIcon" aria-hidden="true">▣</span>
            )}
            <span className="fileCopy">
              <strong>专辑封面</strong>
              <small>{coverName || '导入 MP3 时自动读取内嵌封面，也可手动上传'}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" onChange={(event) => handleCoverFile(event.target.files?.[0])} />
          </label>
        </section>

        <section className="panelGroup fontPanel" inert={isExporting}>
          <h2>字体</h2>
          <label className="fileInput">
            <span className="fileIcon typeIcon" aria-hidden="true">T</span>
            <span className="fileCopy">
              <strong>导入字体</strong>
              <small>{fontStatus === '未导入字体' ? '支持 TTF / OTF / WOFF / WOFF2' : fontStatus}</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input type="file" accept=".ttf,.otf,.woff,.woff2,font/*" onChange={(event) => void handleFontFile(event.target.files?.[0])} />
          </label>

          <label className="field">
            <span>中文字体</span>
            <select value={settings.chineseFont} onChange={(event) => updateSetting('chineseFont', event.target.value)}>
              {fontOptions.map((font) => (
                <option key={`zh-${font.value}`} value={font.value}>{font.label}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>英文字体</span>
            <select value={settings.englishFont} onChange={(event) => updateSetting('englishFont', event.target.value)}>
              {fontOptions.map((font) => (
                <option key={`en-${font.value}`} value={font.value}>{font.label}</option>
              ))}
            </select>
          </label>
        </section>

        <section className="panelGroup typographyGroup lyricsPanel" inert={isExporting}>
          <div className="sectionTitleRow">
            <h2>{activeTextElementLabel}设置</h2>
            <span>已选中</span>
          </div>
          <div className="elementPicker" role="listbox" aria-label="正在编辑的文字元素">
            {([
              ['currentLyric', '当前歌词'],
              ['normalLyric', '普通歌词'],
              ['title', '歌名'],
              ['artist', '歌手'],
              ['brand', '宣传栏'],
              ['playlist', '歌单入口'],
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
            label="字号"
            value={activeTextSize}
            min={getTextElementRange(activeTextElement).min}
            max={getTextElementRange(activeTextElement).max}
            unit="px"
            onChange={updateActiveTextSize}
          />
          <ColorField
            label={activeTextElement === 'currentLyric' ? '基础颜色' : activeTextElement === 'normalLyric' ? '普通歌词颜色' : '文字颜色'}
            value={activeTextColor}
            onChange={updateActiveTextColor}
          />
          {settings.visualStyle === 'tiktok' && activeTextElement === 'currentLyric' && (
            <>
              <RangeField
                label="文字柔化"
                value={settings.tiktokTextBlur}
                min={0}
                max={6}
                unit="px"
                onChange={(value) => updateSetting('tiktokTextBlur', value)}
              />
              <p className="singleLyricNote">0 px 为清晰边缘；约 2 px 接近参考图中轻微发虚的文字质感。</p>
            </>
          )}
          {(activeTextElement === 'currentLyric' || activeTextElement === 'normalLyric') && (
            settings.visualStyle === 'tiktok' ? (
              <p className="singleLyricNote">参考模板固定使用左侧 24% 锚点、47% 排版宽度和自动两端分布；字号与字体仍可在这里调整。</p>
            ) : <>
              <label className="field">
                <span>歌词对齐</span>
                <select
                  value={settings.lyricAlignment}
                  onChange={(event) => updateSetting('lyricAlignment', event.target.value as VisualizerSettings['lyricAlignment'])}
                >
                  <option value="center">居中</option>
                  <option value="left">向左对齐</option>
                </select>
              </label>
              <RangeField label="行距" value={settings.lineGap} min={64} max={180} unit="px" onChange={(value) => updateSetting('lineGap', value)} />
            </>
          )}
        </section>

        <section className="panelGroup paletteGroup backgroundPanel" inert={isExporting}>
          <div className="sectionTitleRow">
            <h2>智能配色</h2>
            <span>LOCAL · OKLAB</span>
          </div>

          <label className="paletteUpload">
            {paletteImageUrl ? (
              <img src={paletteImageUrl} alt="配色参考图预览" />
            ) : (
              <span className="paletteUploadIcon" aria-hidden="true">◌</span>
            )}
            <span className="paletteUploadCopy">
              <strong>{paletteSourceName || '从图片提取色系'}</strong>
              <small>图片只在浏览器本地分析，不会上传</small>
            </span>
            <span className="fileAdd" aria-hidden="true">＋</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif"
              onChange={(event) => void handlePaletteImage(event.target.files?.[0])}
            />
          </label>

          <div className="paletteSwatches" aria-label="当前提取色板">
            {paletteSwatches.map((color, index) => (
              <span key={`${color}-${index}`} style={{ backgroundColor: color }} title={color} />
            ))}
          </div>
          <p className="paletteStatus">{paletteStatus}</p>

          <div className="presetGrid" aria-label="颜色预设">
            {palettePresets.map((palette) => (
              <PalettePresetButton
                key={palette.id}
                palette={palette}
                active={activePaletteId === palette.id}
                onClick={() => {
                  applyPalette(palette)
                  setPaletteStatus(`已应用 ${palette.name} 预设`)
                }}
              />
            ))}
          </div>
        </section>

        <section className="panelGroup visualPanel" inert={isExporting}>
          <h2>{activeStyleTab === 'scene' ? '画面' : activeStyleTab === 'lyrics' ? '歌词排版' : '动效'}</h2>
          <label className="field canvasControl">
            <span>画幅</span>
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
            <span>音乐画面样式</span>
            <select
              value={settings.visualStyle}
              onChange={(event) => selectVisualStyle(event.target.value as VisualizerSettings['visualStyle'])}
            >
              <option value="classic">普通滚动歌词</option>
              <option value="soda">汽水音乐卡片（无短视频侧栏）</option>
              <option value="single">单句整行波动歌词（淡入淡出）</option>
              <option value="tiktok">TikTok 黑白逐词歌词（参考复刻）</option>
            </select>
          </label>

          {settings.visualStyle === 'tiktok' ? (
            <p className="singleLyricNote">画面固定为 9:16 黑底，中间放置一个与画面同宽的白色正方形；上下黑边各占 21.875%，与参考视频的 720×1280 构图一致。</p>
          ) : <div className="backgroundControls">
            <label className="paletteUpload backgroundImageUpload">
              {backgroundImageUrl ? (
                <img src={backgroundImageUrl} alt="自定义画面背景预览" />
              ) : (
                <span className="paletteUploadIcon" aria-hidden="true">▧</span>
              )}
              <span className="paletteUploadCopy">
                <strong>{backgroundImageName || '上传自定义图片背景'}</strong>
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
                label="图片高斯模糊"
                value={settings.backgroundImageBlur}
                min={0}
                max={80}
                unit="px"
                disabled={!backgroundImageUrl}
                onChange={(value) => updateSetting('backgroundImageBlur', value)}
              />
              <RangeField
                label="图片变暗遮罩"
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
                移除自定义背景
              </button>
            )}

            <div className="colorGrid">
              <ColorField label="当前歌词" value={settings.lyricColor} onChange={(value) => updateSetting('lyricColor', value)} />
              <ColorField label="高亮最终颜色" value={settings.progressColor} onChange={(value) => updateSetting('progressColor', value)} />
              <ColorField label="其他歌词" value={settings.nextColor} onChange={(value) => updateSetting('nextColor', value)} />
              <ColorField label="背景" value={settings.backgroundColor} onChange={(value) => updateSetting('backgroundColor', value)} disabled={settings.transparentBackground} />
            </div>
          </div>}

          <div className="lyricControls">
            {settings.visualStyle === 'single' ? (
              <p className="singleLyricNote">每次只显示一句歌词：字形沿整行水波起伏并柔软回弹。可开启入场变速，让新歌词先从上方快速波动，再自然减速为慢波。</p>
            ) : settings.visualStyle === 'tiktok' ? (
              <p className="singleLyricNote">每句歌词预先排版后按单词硬切显现，每屏最多三行，长句会自动切到下一组。增强 LRC 直接使用原逐词时间；普通 LRC 会在相邻两句之间自动分配时间。</p>
            ) : (
              <>
            <div className="field highlightControl highlightModeControl">
              <span>当前歌词高亮</span>
              <div className="highlightModeOptions" role="group" aria-label="当前歌词高亮方式">
                <button
                  className={settings.lyricHighlightMode === 'animated' ? 'active' : ''}
                  type="button"
                  aria-pressed={settings.lyricHighlightMode === 'animated'}
                  onClick={() => updateSetting('lyricHighlightMode', 'animated')}
                >
                  <span>变色动画</span>
                  <span className="highlightModeIndicator" aria-hidden="true" />
                </button>
                <button
                  className={settings.lyricHighlightMode === 'instant' ? 'active' : ''}
                  type="button"
                  aria-pressed={settings.lyricHighlightMode === 'instant'}
                  onClick={() => updateSetting('lyricHighlightMode', 'instant')}
                >
                  <span>直接显示</span>
                  <span className="highlightModeIndicator" aria-hidden="true" />
                </button>
                <button
                  className={settings.lyricHighlightMode === 'focus' ? 'active' : ''}
                  type="button"
                  aria-pressed={settings.lyricHighlightMode === 'focus'}
                  onClick={() => updateSetting('lyricHighlightMode', 'focus')}
                >
                  <span>浮入聚焦</span>
                  <span className="highlightModeIndicator" aria-hidden="true" />
                </button>
              </div>
            </div>

            <label className="field">
              <span>歌词对齐</span>
              <select
                value={settings.lyricAlignment}
                onChange={(event) => updateSetting('lyricAlignment', event.target.value as VisualizerSettings['lyricAlignment'])}
              >
                <option value="center">居中</option>
                <option value="left">向左对齐</option>
              </select>
            </label>

            <RangeField
              label="歌词行距"
              value={settings.lineGap}
              min={64}
              max={180}
              unit="px"
              onChange={(value) => updateSetting('lineGap', value)}
            />

            <RangeField
              label="显示歌词行数"
              value={settings.visibleLineCount}
              min={3}
              max={13}
              unit="行"
              onChange={(value) => updateSetting('visibleLineCount', value)}
            />
              </>
            )}
          </div>

          <div className="motionControls">
            <div className="toggleList">
              <ToggleField
                label="透明背景"
                checked={settings.transparentBackground}
                disabled={settings.visualStyle === 'tiktok'}
                onChange={(checked) => updateSetting('transparentBackground', checked)}
              />
              <ToggleField
                label="显示歌曲信息"
                checked={settings.showMetadata}
                disabled={settings.visualStyle === 'single' || settings.visualStyle === 'tiktok'}
                onChange={(checked) => updateSetting('showMetadata', checked)}
              />
              <ToggleField
                label="显示底部线型进度条"
                checked={settings.showProgressBar}
                disabled={settings.visualStyle === 'single' || settings.visualStyle === 'tiktok'}
                onChange={(checked) => updateSetting('showProgressBar', checked)}
              />
              <ToggleField
                label="歌词入场先快后慢"
                checked={settings.singleWaveSpeedRamp}
                disabled={settings.visualStyle !== 'single'}
                onChange={(checked) => updateSetting('singleWaveSpeedRamp', checked)}
              />
              <ToggleField
                label="显示底部鼓点律动条"
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
            <h2>导出</h2>
            <span>{exportBadge}</span>
          </div>
          <div className="exportRangeMode" role="group" aria-label="导出范围">
            <button
              className={exportRangeMode === 'full' ? 'active' : ''}
              type="button"
              disabled={isExporting}
              aria-pressed={exportRangeMode === 'full'}
              onClick={() => setExportRangeMode('full')}
            >
              完整音频
            </button>
            <button
              className={exportRangeMode === 'selection' ? 'active' : ''}
              type="button"
              disabled={isExporting}
              aria-pressed={exportRangeMode === 'selection'}
              onClick={() => setExportRangeMode('selection')}
            >
              选定片段
            </button>
          </div>
          {exportRangeMode === 'selection' && (
            <div className={hasValidSelection ? 'clipEditor' : 'clipEditor invalid'}>
              <div className="clipSummary">
                <span>{formatTimePrecise(exportStartTime)} – {formatTimePrecise(exportEndTime)}</span>
                <strong>时长 {formatTimePrecise(selectedRangeDuration)}</strong>
              </div>
              <div className="clipRangeField">
                <span className="clipRangeHeader">
                  <span>开始点</span>
                  <button type="button" disabled={isExporting} onClick={() => updateExportStartTime(currentTimeRef.current)}>使用当前位置</button>
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.1, audioDuration)}
                  step={0.1}
                  value={clampNumber(exportStartTime, 0, audioDuration)}
                  disabled={isExporting}
                  aria-label="导出片段开始点"
                  onChange={(event) => updateExportStartTime(Number(event.target.value))}
                />
              </div>
              <div className="clipRangeField">
                <span className="clipRangeHeader">
                  <span>结束点</span>
                  <button type="button" disabled={isExporting} onClick={() => updateExportEndTime(currentTimeRef.current)}>使用当前位置</button>
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(minimumExportDuration, audioDuration)}
                  step={0.1}
                  value={clampNumber(exportEndTime, 0, audioDuration)}
                  disabled={isExporting}
                  aria-label="导出片段结束点"
                  onChange={(event) => updateExportEndTime(Number(event.target.value))}
                />
              </div>
              <div className="clipSeekActions">
                <button type="button" disabled={isExporting} onClick={() => seekTo(exportStartTime)}>跳到开始</button>
                <button type="button" disabled={isExporting} onClick={() => seekTo(exportEndTime)}>跳到结束</button>
              </div>
              {!hasValidSelection && <p className="clipError">结束点必须晚于开始点至少 0.1 秒</p>}
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
                  <strong>逐词 PNG 序列</strong>
                  <p>片段起始状态与每次新增词都会生成一张完整图片，统一打包为 ZIP。</p>
                </div>
                <span>{tiktokFrameCount} 张</span>
              </div>
              <button
                className="tiktokFrameExportButton"
                type="button"
                onClick={() => void startTikTokFrameExport()}
                disabled={isExporting || !hasValidSelection || tiktokFrameCount === 0}
              >
                <span aria-hidden="true">▣</span>
                {isExporting ? `正在生成 ${Math.round(exportProgress * 100)}%` : '导出逐词 PNG（ZIP）'}
              </button>
            </div>
          )}
          <div className="meter" aria-label="导出进度">
            <span style={{ width: `${Math.round(exportProgress * 100)}%` }} />
          </div>
          <p className="statusLine">{exportStatus}</p>
          {settings.transparentBackground && (
            <p className="statusLine">透明画布可预览；MP4 通常不保留 alpha，WebM/VP9 更适合透明素材。</p>
          )}
          {fastExportSupport?.supported && (
            <p className="statusLine">画面与音频均直接编码，不使用 MediaRecorder 或预览录制；切换窗口不会影响成片。</p>
          )}
          {fastExportSupport && !fastExportSupport.supported && (
            <p className="statusLine">{fastExportSupport.reason}</p>
          )}
          {exportResult && (
            <a className="downloadButton" href={exportResult.url} download={exportResult.filename}>
              <span aria-hidden="true">↓</span>
              下载 {exportResult.filename.endsWith('.mp4') ? 'MP4' : 'WebM'}
            </a>
          )}
          {frameSequenceResult && settings.visualStyle === 'tiktok' && (
            <a className="downloadButton" href={frameSequenceResult.url} download={frameSequenceResult.filename}>
              <span aria-hidden="true">↓</span>
              下载逐词 PNG 序列（{frameSequenceResult.frameCount} 张）
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
                <span>纯文本歌词</span>
                <h2 id="pasteLyricsTitle">粘贴歌词并开始打轴</h2>
                <p>每一行会成为一句歌词；空行会自动忽略。</p>
              </div>
              <button type="button" aria-label="关闭粘贴歌词窗口" onClick={() => setIsPasteLyricsOpen(false)}>×</button>
            </header>
            <textarea
              autoFocus
              value={pastedLyricsText}
              placeholder={'把歌词粘贴到这里，例如：\n第一句歌词\n第二句歌词\n第三句歌词'}
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
                <strong>{parsePlainTextLyrics(pastedLyricsText).length} 行歌词</strong>
                <span className={pasteLyricsError ? 'pasteLyricsError' : ''}>{pasteLyricsError || '⌘/Ctrl + Enter 可直接进入打轴器'}</span>
              </div>
              <div>
                <button type="button" onClick={() => setIsPasteLyricsOpen(false)}>取消</button>
                <button className="pasteLyricsStartButton" type="button" disabled={parsePlainTextLyrics(pastedLyricsText).length === 0} onClick={startTimingPastedLyrics}>进入打轴器</button>
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
          onCancel={() => setTimingEditorSource(null)}
          onApply={applyTimedLyrics}
        />
      )}
    </main>
  )
}

function PalettePresetButton(props: {
  palette: VisualizerPalette
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
        <small>{props.palette.description}</small>
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
            aria-label={`${props.label}数值`}
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
