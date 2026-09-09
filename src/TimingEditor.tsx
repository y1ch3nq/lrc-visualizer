import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { alignLyricsToAudio, tokenizeLyricWords } from './audio-word-alignment.ts'
import {
  formatLrcTimestamp,
  serializeExtendedLrc,
  splitLyricGraphemes,
  type LyricLine,
  type LyricWord,
} from './lrc.ts'
import { localizeErrorMessage, pickUiText, type UiLanguage } from './ui-language.ts'

export interface TimingDraftLine {
  id: string
  text: string
  startTime?: number
  endTime?: number
  words?: LyricWord[]
}

interface TimingEditorProps {
  language: UiLanguage
  audioUrl: string
  audioFile: File | null
  audioDuration: number
  sourceName: string
  metadata: Record<string, string>
  initialLines: TimingDraftLine[]
  onCancel: () => void
  onApply: (lines: LyricLine[], sourceName: string) => void
}

interface DraftValidation {
  errors: string[]
  lineErrors: Map<number, string>
}

interface WordTimingDraft {
  text: string
  time?: number
}

export function TimingEditor({
  language,
  audioUrl,
  audioFile,
  audioDuration,
  sourceName,
  metadata,
  initialLines,
  onCancel,
  onApply,
}: TimingEditorProps) {
  const ui = useCallback((chinese: string, english: string) => (
    pickUiText(language, chinese, english)
  ), [language])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [lines, setLines] = useState<TimingDraftLine[]>(() => initialLines.map(cloneDraftLine))
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const untimedIndex = initialLines.findIndex((line) => line.startTime === undefined)
    return untimedIndex >= 0 ? untimedIndex : 0
  })
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [status, setStatus] = useState(() => pickUiText(
    language,
    '空格打句首并自动进入下一句；E 可补记当前句或上一句的句尾。所有处理都在当前浏览器完成。',
    'Press Space to mark a line start and advance; press E to mark the current or previous line end. Everything stays in this browser.',
  ))
  const [isAligning, setIsAligning] = useState(false)
  const [activeWordTimingLineId, setActiveWordTimingLineId] = useState<string | null>(null)
  const [wordTimingDrafts, setWordTimingDrafts] = useState<Record<string, WordTimingDraft[]>>({})
  const [wordTimingCursor, setWordTimingCursor] = useState(0)

  useEffect(() => {
    setStatus(pickUiText(
      language,
      '空格打句首并自动进入下一句；E 可补记当前句或上一句的句尾。所有处理都在当前浏览器完成。',
      'Press Space to mark a line start and advance; press E to mark the current or previous line end. Everything stays in this browser.',
    ))
  }, [language])

  const validation = useMemo(() => validateDraft(lines, language), [language, lines])
  const selectedLine = lines[selectedIndex]
  const activeIndex = useMemo(() => findActiveDraftLine(lines, currentTime), [currentTime, lines])
  const isWordTimingMode = Boolean(selectedLine && activeWordTimingLineId === selectedLine.id)
  const activeWordDrafts = selectedLine ? wordTimingDrafts[selectedLine.id] ?? [] : []
  const activeWordDraft = activeWordDrafts[wordTimingCursor]
  const incompleteWordTimingLineCount = useMemo(() => Object.values(wordTimingDrafts).filter((drafts) => {
    const timedCount = drafts.filter((word) => word.time !== undefined).length
    return timedCount > 0 && timedCount < drafts.length
  }).length, [wordTimingDrafts])
  const blockingIssueCount = validation.errors.length + incompleteWordTimingLineCount

  const seekTo = useCallback((time: number) => {
    const safeTime = clampNumber(time, 0, Math.max(audioDuration, 0))
    if (audioRef.current) {
      audioRef.current.currentTime = safeTime
    }
    setCurrentTime(safeTime)
  }, [audioDuration])

  const selectLine = useCallback((index: number, seek = false) => {
    const safeIndex = clampNumber(index, 0, Math.max(0, lines.length - 1))
    setActiveWordTimingLineId(null)
    setSelectedIndex(safeIndex)
    const line = lines[safeIndex]
    if (seek && line?.startTime !== undefined) {
      seekTo(line.startTime)
    }
  }, [lines, seekTo])

  const updateLine = useCallback((index: number, patch: Partial<TimingDraftLine>) => {
    setLines((current) => current.map((line, lineIndex) => (
      lineIndex === index ? { ...line, ...patch } : line
    )))
  }, [])

  const invalidateWordTiming = useCallback((lineId: string) => {
    setWordTimingDrafts((current) => {
      if (!current[lineId]) return current
      const next = { ...current }
      delete next[lineId]
      return next
    })
    setActiveWordTimingLineId((current) => current === lineId ? null : current)
  }, [])

  const clearAllTiming = useCallback(() => {
    audioRef.current?.pause()
    setLines((current) => current.map((line) => ({
      ...line,
      startTime: undefined,
      endTime: undefined,
      words: [],
    })))
    setWordTimingDrafts({})
    setActiveWordTimingLineId(null)
    setWordTimingCursor(0)
    setSelectedIndex(0)
    seekTo(0)
    setStatus(ui(
      `已清空全部 ${lines.length} 句的句首、句尾和逐词时间；歌词文字已保留。`,
      `Cleared line starts, ends, and word timing from all ${lines.length} lines. Lyric text was preserved.`,
    ))
  }, [lines.length, seekTo, ui])

  const deleteSelectedLine = useCallback(() => {
    if (!selectedLine) {
      return
    }

    const deletedLineId = selectedLine.id
    const remainingLineCount = Math.max(0, lines.length - 1)
    setLines((current) => current.filter((line) => line.id !== deletedLineId))
    setWordTimingDrafts((current) => {
      if (!current[deletedLineId]) return current
      const next = { ...current }
      delete next[deletedLineId]
      return next
    })
    setActiveWordTimingLineId(null)
    setWordTimingCursor(0)
    setSelectedIndex(Math.min(selectedIndex, Math.max(0, remainingLineCount - 1)))
    setStatus(ui(
      `已删除第 ${selectedIndex + 1} 句，剩余 ${remainingLineCount} 句。`,
      `Deleted line ${selectedIndex + 1}. ${remainingLineCount} ${remainingLineCount === 1 ? 'line remains' : 'lines remain'}.`,
    ))
  }, [lines.length, selectedIndex, selectedLine, ui])

  const beginWordTiming = useCallback(() => {
    if (!selectedLine) {
      return
    }
    if (selectedLine.startTime === undefined) {
      setStatus(ui('请先用 Space 标记这句的句首，再进入逐词打轴。', 'Mark this line start with Space before entering word timing mode.'))
      return
    }

    const existingDrafts = wordTimingDrafts[selectedLine.id]
    const existingWords = selectedLine.words ?? []
    const drafts: WordTimingDraft[] = existingDrafts && existingDrafts.length > 0
      ? existingDrafts
      : existingWords.length > 0
        ? existingWords.map((word) => ({ text: word.text, time: word.time }))
        : tokenizeSmartWordTiming(selectedLine.text).map((text) => ({ text }))
    if (drafts.length === 0) {
      setStatus(ui('当前句没有可打轴的文字。', 'This line has no text to time.'))
      return
    }

    setWordTimingDrafts((current) => ({ ...current, [selectedLine.id]: drafts }))
    const firstUntimedIndex = drafts.findIndex((word) => word.time === undefined)
    setWordTimingCursor(firstUntimedIndex >= 0 ? firstUntimedIndex : 0)
    setActiveWordTimingLineId(selectedLine.id)
    setStatus(ui(
      `已进入第 ${selectedIndex + 1} 句逐词模式；Space 给当前词打点并自动进入下一个词。`,
      `Word timing mode is active for line ${selectedIndex + 1}. Press Space to mark the current word and advance.`,
    ))
  }, [selectedIndex, selectedLine, ui, wordTimingDrafts])

  const resetWordTiming = useCallback((segmentation: 'keep' | 'smart' | 'character' = 'keep') => {
    if (!selectedLine) {
      return
    }
    const currentDrafts = wordTimingDrafts[selectedLine.id] ?? []
    const tokenTexts = segmentation === 'keep' && currentDrafts.length > 0
      ? currentDrafts.map((word) => word.text)
      : segmentation === 'character'
        ? tokenizeWordTimingCharacters(selectedLine.text)
        : tokenizeSmartWordTiming(selectedLine.text)
    const drafts = tokenTexts.map((text) => ({ text }))
    setWordTimingDrafts((current) => ({ ...current, [selectedLine.id]: drafts }))
    setWordTimingCursor(0)
    updateLine(selectedIndex, { words: [] })
    setStatus(segmentation === 'character'
      ? ui('已按字拆分，请从第一个字重新打点。', 'Split into characters. Start timing again from the first character.')
      : ui('逐词时间已重置，请从第一个词重新打点。', 'Word timing has been reset. Start again from the first word.'))
  }, [selectedIndex, selectedLine, ui, updateLine, wordTimingDrafts])

  const markCurrentWord = useCallback(() => {
    if (!selectedLine || !isWordTimingMode || !activeWordDraft) {
      return
    }
    if (selectedLine.startTime === undefined) {
      setStatus(ui('当前句缺少句首时间。', 'The current line has no start time.'))
      return
    }

    const nextLineStart = lines[selectedIndex + 1]?.startTime
    const timingWindowEnd = selectedLine.endTime
      ?? nextLineStart
      ?? Math.max(audioDuration, selectedLine.startTime + 1)
    if (currentTime < selectedLine.startTime) {
      setStatus(ui(
        `当前播放点早于句首 ${formatClock(selectedLine.startTime)}。`,
        `The playhead is before the line start at ${formatClock(selectedLine.startTime)}.`,
      ))
      return
    }
    if (currentTime > timingWindowEnd) {
      setStatus(ui(
        `当前播放点晚于这句可用的结束时间 ${formatClock(timingWindowEnd)}。`,
        `The playhead is after this line's available end time at ${formatClock(timingWindowEnd)}.`,
      ))
      return
    }

    const previousTime = activeWordDrafts[wordTimingCursor - 1]?.time
    if (previousTime !== undefined && currentTime <= previousTime) {
      setStatus(ui(
        `“${activeWordDraft.text}”的时间必须晚于上一个词 ${formatClock(previousTime)}。`,
        `“${activeWordDraft.text}” must be later than the previous word at ${formatClock(previousTime)}.`,
      ))
      return
    }

    const nextDrafts = activeWordDrafts.map((word, index) => {
      if (index === wordTimingCursor) {
        return { ...word, time: currentTime }
      }
      if (index > wordTimingCursor && word.time !== undefined && word.time <= currentTime) {
        return { ...word, time: undefined }
      }
      return word
    })
    const isComplete = nextDrafts.every((word) => word.time !== undefined)
    setWordTimingDrafts((current) => ({ ...current, [selectedLine.id]: nextDrafts }))
    updateLine(selectedIndex, {
      words: isComplete
        ? nextDrafts.map((word) => ({ text: word.text, time: word.time as number }))
        : [],
    })

    const nextUntimedIndex = nextDrafts.findIndex((word, index) => index > wordTimingCursor && word.time === undefined)
    if (nextUntimedIndex >= 0) {
      setWordTimingCursor(nextUntimedIndex)
      setStatus(ui(
        `“${activeWordDraft.text}”已标记 ${formatClock(currentTime)}；下一个词：“${nextDrafts[nextUntimedIndex].text}”。`,
        `Marked “${activeWordDraft.text}” at ${formatClock(currentTime)}. Next word: “${nextDrafts[nextUntimedIndex].text}”.`,
      ))
    } else {
      setStatus(ui(
        `第 ${selectedIndex + 1} 句逐词打轴完成，共 ${nextDrafts.length} 个词。`,
        `Word timing for line ${selectedIndex + 1} is complete with ${nextDrafts.length} words.`,
      ))
    }
  }, [activeWordDraft, activeWordDrafts, audioDuration, currentTime, isWordTimingMode, lines, selectedIndex, selectedLine, ui, updateLine, wordTimingCursor])

  const markStart = useCallback(() => {
    if (!selectedLine) {
      return
    }
    updateLine(selectedIndex, {
      startTime: currentTime,
      endTime: selectedLine.endTime !== undefined && selectedLine.endTime <= currentTime
        ? undefined
        : selectedLine.endTime,
      words: [],
    })
    invalidateWordTiming(selectedLine.id)
    setStatus(ui(
      `第 ${selectedIndex + 1} 句句首：${formatClock(currentTime)}${selectedIndex < lines.length - 1 ? '；已选择下一句' : ''}`,
      `Line ${selectedIndex + 1} starts at ${formatClock(currentTime)}${selectedIndex < lines.length - 1 ? '; selected the next line' : ''}.`,
    ))
    if (selectedIndex < lines.length - 1) {
      setSelectedIndex(selectedIndex + 1)
    }
  }, [currentTime, invalidateWordTiming, lines.length, selectedIndex, selectedLine, ui, updateLine])

  const handleSpaceAction = useCallback(() => {
    if (isWordTimingMode) {
      markCurrentWord()
    } else {
      markStart()
    }
  }, [isWordTimingMode, markCurrentWord, markStart])

  const markEnd = useCallback(() => {
    if (!selectedLine) {
      return
    }
    const targetIndex = selectedLine.startTime === undefined && selectedIndex > 0
      ? selectedIndex - 1
      : selectedIndex
    const targetLine = lines[targetIndex]
    if (!targetLine || targetLine.startTime === undefined) {
      setStatus(ui('请先用空格标记句首，再标记句尾。', 'Mark a line start with Space before marking its end.'))
      return
    }
    if (currentTime <= targetLine.startTime) {
      setStatus(ui('句尾必须晚于句首。', 'The line end must be later than its start.'))
      return
    }
    const targetStartTime = targetLine.startTime
    updateLine(targetIndex, {
      endTime: currentTime,
      words: (targetLine.words ?? []).filter((word) => word.time >= targetStartTime && word.time <= currentTime),
    })
    setWordTimingDrafts((current) => {
      const drafts = current[targetLine.id]
      if (!drafts) return current
      return {
        ...current,
        [targetLine.id]: drafts.map((word) => (
          word.time !== undefined && word.time > currentTime ? { ...word, time: undefined } : word
        )),
      }
    })
    setStatus(ui(
      `第 ${targetIndex + 1} 句句尾：${formatClock(currentTime)}；逐词动画会在这里完成，整句保持到下一句出现。`,
      `Line ${targetIndex + 1} ends at ${formatClock(currentTime)}. Word animation completes here and the line remains until the next one appears.`,
    ))
    if (!isWordTimingMode && targetIndex === selectedIndex && selectedIndex < lines.length - 1) {
      setSelectedIndex(selectedIndex + 1)
    }
  }, [currentTime, isWordTimingMode, lines, selectedIndex, selectedLine, ui, updateLine])

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current
    if (!audioUrl || !audio) {
      setStatus(ui('请先在主界面导入歌曲音频。', 'Import the song audio from the main screen first.'))
      return
    }
    if (audio.paused) {
      await audio.play().catch(() => setStatus(ui('浏览器暂时无法播放这个音频文件。', 'The browser cannot play this audio file right now.')))
    } else {
      audio.pause()
    }
  }, [audioUrl, ui])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isEditingText = target?.matches(
        'textarea, input:not([type="range"]):not([type="button"]):not([type="submit"]), [contenteditable="true"]',
      ) ?? false
      if (isEditingText && event.key !== 'Escape') {
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }
      if (event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        handleSpaceAction()
        return
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        markEnd()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        void togglePlayback()
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        selectLine(selectedIndex + (event.key === 'ArrowUp' ? -1 : 1), true)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        event.stopPropagation()
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        seekTo(currentTime + direction * (event.shiftKey ? 0.5 : 0.05))
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [currentTime, handleSpaceAction, markEnd, onCancel, seekTo, selectLine, selectedIndex, togglePlayback])

  const buildTimedLines = useCallback((): LyricLine[] | null => {
    const currentValidation = validateDraft(lines, language)
    if (currentValidation.errors.length > 0) {
      setStatus(currentValidation.errors[0])
      return null
    }
    if (incompleteWordTimingLineCount > 0) {
      setStatus(ui(
        `还有 ${incompleteWordTimingLineCount} 句只完成了部分逐词打点；请完成或清空这些逐词时间。`,
        `${incompleteWordTimingLineCount} ${incompleteWordTimingLineCount === 1 ? 'line has' : 'lines have'} partial word timing. Complete or clear those word times.`,
      ))
      return null
    }

    return lines.map((line) => ({
      id: line.id,
      time: line.startTime as number,
      endTime: line.endTime,
      text: line.text.trim(),
      words: (line.words ?? []).filter((word) => (
        word.time >= (line.startTime as number)
        && (line.endTime === undefined || word.time <= line.endTime)
      )),
    }))
  }, [incompleteWordTimingLineCount, language, lines, ui])

  const runAcousticAlignment = async () => {
    if (!audioFile) {
      setStatus(ui('请先在主界面导入歌曲音频，才能运行本地声学对齐。', 'Import the song audio from the main screen before running local acoustic alignment.'))
      return
    }
    const timedLines = buildTimedLines()
    if (!timedLines) {
      return
    }

    setIsAligning(true)
    setStatus(ui('正在浏览器内分析声音起点并对齐逐词时间…', 'Analyzing sound onsets and aligning word timing in your browser…'))
    try {
      const result = await alignLyricsToAudio(audioFile, timedLines, audioDuration)
      setLines(result.lines.map((line) => ({
        id: line.id,
        text: line.text,
        startTime: line.time,
        endTime: line.endTime,
        words: line.words,
      })))
      setWordTimingDrafts({})
      setActiveWordTimingLineId(null)
      setStatus(ui(
        `已为 ${result.alignedLineCount} 句生成逐词时间；检测到 ${result.detectedOnsetCount} 个声音起点，参考置信度 ${Math.round(result.confidence * 100)}%。`,
        `Generated word timing for ${result.alignedLineCount} lines from ${result.detectedOnsetCount} detected sound onsets, with ${Math.round(result.confidence * 100)}% reference confidence.`,
      ))
    } catch (error) {
      setStatus(error instanceof Error
        ? localizeErrorMessage(error.message, language)
        : ui('本地声学对齐失败', 'Local acoustic alignment failed'))
    } finally {
      setIsAligning(false)
    }
  }

  const downloadExtendedLrc = () => {
    const timedLines = buildTimedLines()
    if (!timedLines) {
      return
    }
    const content = serializeExtendedLrc(timedLines, metadata)
    const blobUrl = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = blobUrl
    anchor.download = `${stripExtension(sourceName) || 'lyrics'}.lrc`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0)
    setStatus(ui('扩展 LRC 已下载；句尾使用 <end:mm:ss.xx> 保存。', 'Extended LRC downloaded. Line ends are saved with <end:mm:ss.xx>.'))
  }

  const applyTiming = () => {
    const timedLines = buildTimedLines()
    if (!timedLines) {
      return
    }
    onApply(timedLines, sourceName)
  }

  return (
    <div className="timingEditorBackdrop" role="presentation">
      <section className="timingEditorDialog" role="dialog" aria-modal="true" aria-labelledby="timingEditorTitle">
        <header className="timingEditorHeader">
          <div>
            <span className="timingEditorEyebrow">{ui('纯前端歌词打轴器', 'In-browser lyric timing editor')}</span>
            <h2 id="timingEditorTitle">{ui('句首、句尾和逐词时间', 'Line starts, ends & word timing')}</h2>
            <p>{sourceName} · {ui('音频与歌词不会上传', 'Audio and lyrics never leave your browser')}</p>
          </div>
          <button className="timingCloseButton" type="button" onClick={onCancel} aria-label={ui('关闭打轴器', 'Close timing editor')}>×</button>
        </header>

        <div className="timingTransport">
          <button className="timingPlayButton" type="button" disabled={!audioUrl} onClick={() => void togglePlayback()}>
            {isPlaying ? ui('暂停', 'Pause') : ui('播放', 'Play')}
          </button>
          <div className="timingClock">
            <strong>{formatClock(currentTime)}</strong>
            <span>/ {formatClock(audioDuration)}</span>
          </div>
          <input
            className="timingSeek"
            type="range"
            min={0}
            max={Math.max(0.01, audioDuration)}
            step={0.01}
            value={clampNumber(currentTime, 0, Math.max(0.01, audioDuration))}
            disabled={!audioUrl}
            aria-label={ui('打轴器播放进度', 'Timing editor playback position')}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
          <label className="timingRate">
            <span>{ui('速度', 'Speed')}</span>
            <select
              value={playbackRate}
              onChange={(event) => {
                const nextRate = Number(event.target.value)
                setPlaybackRate(nextRate)
                if (audioRef.current) audioRef.current.playbackRate = nextRate
                event.currentTarget.blur()
              }}
            >
              <option value={0.5}>0.5×</option>
              <option value={0.75}>0.75×</option>
              <option value={1}>1×</option>
              <option value={1.25}>1.25×</option>
            </select>
          </label>
        </div>

        <audio
          ref={audioRef}
          src={audioUrl || undefined}
          preload="auto"
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />

        <div className="timingEditorBody">
          <div className="timingLineColumn">
            <div className="timingColumnTitle">
              <div className="timingColumnTitleCopy">
                <span>{ui('歌词行', 'Lyric lines')}</span>
                <small>{ui(
                  `${lines.length} 句 · ${lines.filter((line) => line.startTime !== undefined).length} 句已有句首`,
                  `${lines.length} lines · ${lines.filter((line) => line.startTime !== undefined).length} timed`,
                )}</small>
              </div>
              <button
                className="timingClearAllButton"
                type="button"
                disabled={lines.length === 0}
                onClick={clearAllTiming}
              >
                {ui('一键清空全部时间', 'Clear all timing')}
              </button>
            </div>
            <div className="timingLineList">
              {lines.map((line, index) => {
                const rowError = validation.lineErrors.get(index)
                const classNames = [
                  'timingLineRow',
                  index === selectedIndex ? 'selected' : '',
                  index === activeIndex ? 'playing' : '',
                  rowError ? 'invalid' : '',
                ].filter(Boolean).join(' ')
                return (
                  <button key={line.id} className={classNames} type="button" onClick={() => selectLine(index, true)}>
                    <span className="timingLineNumber">{String(index + 1).padStart(2, '0')}</span>
                    <span className="timingLineCopy">
                      <strong>{line.text || ui('空歌词行', 'Empty lyric line')}</strong>
                      <small>
                        {line.startTime === undefined ? ui('未打句首', 'No start') : formatClock(line.startTime)}
                        {' → '}
                        {line.endTime === undefined ? ui('下一句句首', 'Next line start') : formatClock(line.endTime)}
                        {line.words?.length ? ui(` · ${line.words.length} 个逐词点`, ` · ${line.words.length} word marks`) : ''}
                      </small>
                      {rowError && <em>{rowError}</em>}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="timingInspector">
            <div className="timingNowCard">
              <span>{ui('当前句', 'Current line')}</span>
              <strong>{selectedLine?.text || ui('没有歌词', 'No lyrics')}</strong>
              <small>{ui('下一句：', 'Next line: ')}{lines[selectedIndex + 1]?.text || '—'}</small>
            </div>

            <div className="timingMarkButtons">
              <button className="startMark" type="button" disabled={!selectedLine} onClick={handleSpaceAction}>
                <kbd>Space</kbd>
                <span>
                  <strong>{isWordTimingMode
                    ? ui(`给“${activeWordDraft?.text ?? '当前词'}”打点`, `Mark “${activeWordDraft?.text ?? 'current word'}”`)
                    : ui('打句首并下一句', 'Mark start & advance')}</strong>
                  <small>{formatClock(currentTime)}</small>
                </span>
              </button>
              <button className="endMark" type="button" disabled={!selectedLine} onClick={markEnd}>
                <kbd>E</kbd>
                <span><strong>{ui('补记句尾', 'Mark line end')}</strong><small>{ui('整句保持到下一句出现', 'Keep the line until the next one appears')}</small></span>
              </button>
            </div>

            {selectedLine && (
              <div className="timingFieldGroup">
                <label>
                  <span>{ui('歌词文字', 'Lyric text')}</span>
                  <textarea
                    value={selectedLine.text}
                    rows={3}
                    onChange={(event) => {
                      updateLine(selectedIndex, { text: event.target.value, words: [] })
                      invalidateWordTiming(selectedLine.id)
                    }}
                  />
                </label>
                <div className="timingNumberGrid">
                  <TimeNumberField
                    label={ui('句首（秒）', 'Line start (seconds)')}
                    placeholder={ui('未设置', 'Not set')}
                    value={selectedLine.startTime}
                    onChange={(value) => {
                      updateLine(selectedIndex, { startTime: value, words: [] })
                      invalidateWordTiming(selectedLine.id)
                    }}
                  />
                  <TimeNumberField
                    label={ui('句尾（秒，可选）', 'Line end (seconds, optional)')}
                    placeholder={ui('未设置', 'Not set')}
                    value={selectedLine.endTime}
                    onChange={(value) => {
                      updateLine(selectedIndex, { endTime: value, words: [] })
                      invalidateWordTiming(selectedLine.id)
                    }}
                  />
                </div>
                <div className="timingFineSeek">
                  <button type="button" onClick={() => seekTo(currentTime - 0.05)}>−0.05s</button>
                  <button type="button" onClick={() => seekTo(currentTime + 0.05)}>+0.05s</button>
                  <button type="button" onClick={() => {
                    updateLine(selectedIndex, { startTime: undefined, endTime: undefined, words: [] })
                    invalidateWordTiming(selectedLine.id)
                  }}>{ui('清除此句时间', 'Clear line timing')}</button>
                  <button className="timingDeleteLineButton" type="button" onClick={deleteSelectedLine}>
                    {ui('删除当前句', 'Delete current line')}
                  </button>
                </div>
              </div>
            )}

            {selectedLine && !isWordTimingMode && (
              <div className="manualWordTimingCard">
                <div>
                  <strong>{ui('单句逐词打轴', 'Word timing for this line')}</strong>
                  <p>{ui('为当前句单独记录每个词出现的时间。进入后 Space 将逐词打点，不会切换歌词行。', 'Record when each word appears in this line. In this mode, Space marks words without changing lyric lines.')}</p>
                </div>
                <button type="button" disabled={selectedLine.startTime === undefined} onClick={beginWordTiming}>
                  {(selectedLine.words?.length ?? 0) > 0
                    ? ui(`编辑 ${selectedLine.words?.length ?? 0} 个逐词点`, `Edit ${selectedLine.words?.length ?? 0} word marks`)
                    : ui('进入逐词模式', 'Enter word timing')}
                </button>
              </div>
            )}

            {selectedLine && isWordTimingMode && (
              <section className="manualWordTimingWorkspace" aria-label={ui('单句逐词打轴', 'Word timing for one line')}>
                <header>
                  <div>
                    <span>{ui(`逐词模式 · 第 ${selectedIndex + 1} 句`, `Word timing · Line ${selectedIndex + 1}`)}</span>
                    <strong>{ui('当前词：', 'Current word: ')}{activeWordDraft?.text ?? ui('已完成', 'Complete')}</strong>
                    <small>{ui(
                      `${activeWordDrafts.filter((word) => word.time !== undefined).length} / ${activeWordDrafts.length} 个词已有时间`,
                      `${activeWordDrafts.filter((word) => word.time !== undefined).length} / ${activeWordDrafts.length} words timed`,
                    )}</small>
                  </div>
                  <button type="button" onClick={() => setActiveWordTimingLineId(null)}>{ui('退出逐词模式', 'Exit word timing')}</button>
                </header>

                <div className="wordTimingTokens" role="list" aria-label={ui('逐词时间点', 'Word timing marks')}>
                  {activeWordDrafts.map((word, index) => (
                    <button
                      key={`${selectedLine.id}-${index}-${word.text}`}
                      className={[
                        'wordTimingToken',
                        index === wordTimingCursor ? 'active' : '',
                        word.time !== undefined ? 'timed' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="listitem"
                      onClick={() => setWordTimingCursor(index)}
                    >
                      <strong>{word.text}</strong>
                      <small>{word.time === undefined ? ui('未打点', 'Not timed') : formatClock(word.time)}</small>
                    </button>
                  ))}
                </div>

                <div className="wordTimingActions">
                  <button type="button" disabled={wordTimingCursor <= 0} onClick={() => setWordTimingCursor((index) => Math.max(0, index - 1))}>{ui('上一个词', 'Previous word')}</button>
                  <button className="wordTimingStampButton" type="button" disabled={!activeWordDraft} onClick={markCurrentWord}>{ui('Space · 给当前词打点', 'Space · Mark current word')}</button>
                  <button type="button" disabled={wordTimingCursor >= activeWordDrafts.length - 1} onClick={() => setWordTimingCursor((index) => Math.min(activeWordDrafts.length - 1, index + 1))}>{ui('下一个词', 'Next word')}</button>
                </div>

                <div className="wordTimingSegmentation">
                  <span>{ui('分词不合适？', 'Need different segmentation?')}</span>
                  <button type="button" onClick={() => resetWordTiming('smart')}>{ui('智能重新分词', 'Smart re-segment')}</button>
                  <button type="button" onClick={() => resetWordTiming('character')}>{ui('按字拆分', 'Split by character')}</button>
                  <button type="button" onClick={() => resetWordTiming('keep')}>{ui('只清空时间', 'Clear timing only')}</button>
                </div>
              </section>
            )}

            <div className="timingShortcutHelp">
              <span><kbd>Enter</kbd> {ui('播放/暂停', 'Play/Pause')}</span>
              <span><kbd>Space</kbd> {isWordTimingMode ? ui('当前词打点', 'Mark current word') : ui('句首并下一句', 'Start & next line')}</span>
              <span><kbd>↑ ↓</kbd> {ui('切换句子', 'Change line')}</span>
              <span><kbd>← →</kbd> {ui('微调 0.05s', 'Nudge 0.05s')}</span>
              <span><kbd>Shift</kbd> + ← → {ui('微调 0.5s', 'Nudge 0.5s')}</span>
            </div>

            <div className="timingAlignmentCard">
              <div>
                <strong>{ui('本地声学逐词对齐', 'Local acoustic word alignment')}</strong>
                <p>{ui('根据已知歌词和声音起点微调每个词，不是语音识别；明确句尾后效果会更稳定。', 'Refines each word from known lyrics and sound onsets; this is not speech recognition. Explicit line ends improve stability.')}</p>
              </div>
              <button type="button" disabled={!audioFile || isAligning} onClick={() => void runAcousticAlignment()}>
                {isAligning ? ui('分析中…', 'Analyzing…') : ui('生成逐词时间', 'Generate word timing')}
              </button>
            </div>
          </div>
        </div>

        <footer className="timingEditorFooter">
          <div className={blockingIssueCount > 0 ? 'timingStatus hasError' : 'timingStatus'}>
            <strong>{blockingIssueCount > 0
              ? ui(`${blockingIssueCount} 处需要处理`, `${blockingIssueCount} ${blockingIssueCount === 1 ? 'issue' : 'issues'} to resolve`)
              : ui('时间轴可应用', 'Timeline ready to apply')}</strong>
            <span>{status}</span>
          </div>
          <div className="timingFooterActions">
            <button type="button" onClick={onCancel}>{ui('取消', 'Cancel')}</button>
            <button type="button" disabled={blockingIssueCount > 0} onClick={downloadExtendedLrc}>{ui('下载扩展 LRC', 'Download extended LRC')}</button>
            <button className="timingApplyButton" type="button" disabled={blockingIssueCount > 0} onClick={applyTiming}>{ui('应用到生成器', 'Apply to visualizer')}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function TimeNumberField(props: {
  label: string
  placeholder: string
  value?: number
  onChange: (value: number | undefined) => void
}) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        type="number"
        min={0}
        step={0.01}
        value={props.value ?? ''}
        placeholder={props.placeholder}
        onChange={(event) => {
          const rawValue = event.target.value
          if (rawValue === '') {
            props.onChange(undefined)
            return
          }
          const value = Number(rawValue)
          if (Number.isFinite(value)) props.onChange(Math.max(0, value))
        }}
      />
    </label>
  )
}

function validateDraft(lines: TimingDraftLine[], language: UiLanguage): DraftValidation {
  const errors: string[] = []
  const lineErrors = new Map<number, string>()
  let previousStart = -1

  lines.forEach((line, index) => {
    let message = ''
    if (!line.text.trim()) {
      message = pickUiText(language, '歌词不能为空', 'Lyric text cannot be empty')
    } else if (line.startTime === undefined) {
      message = pickUiText(language, '缺少句首时间', 'Missing line start time')
    } else if (line.startTime <= previousStart) {
      message = pickUiText(language, '句首必须晚于上一句', 'Line start must be later than the previous line')
    } else if (line.endTime !== undefined && line.endTime <= line.startTime) {
      message = pickUiText(language, '句尾必须晚于句首', 'Line end must be later than its start')
    } else {
      const nextStart = lines[index + 1]?.startTime
      if (line.endTime !== undefined && nextStart !== undefined && line.endTime > nextStart + 0.001) {
        message = pickUiText(language, '句尾不能晚于下一句句首', 'Line end cannot be later than the next line start')
      }
    }

    if (line.startTime !== undefined) {
      previousStart = line.startTime
    }
    if (message) {
      lineErrors.set(index, message)
      errors.push(pickUiText(language, `第 ${index + 1} 句：${message}`, `Line ${index + 1}: ${message}`))
    }
  })

  if (lines.length === 0) {
    errors.push(pickUiText(language, '没有可打轴的歌词行', 'There are no lyric lines to time'))
  }
  return { errors, lineErrors }
}

function findActiveDraftLine(lines: TimingDraftLine[], currentTime: number): number {
  let activeIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startTime === undefined || currentTime < line.startTime) {
      continue
    }
    const nextStart = lines[index + 1]?.startTime
    if (nextStart === undefined || currentTime < nextStart) {
      activeIndex = index
    }
  }
  return activeIndex
}

function cloneDraftLine(line: TimingDraftLine): TimingDraftLine {
  return {
    ...line,
    words: line.words?.map((word) => ({ ...word })) ?? [],
  }
}

function tokenizeSmartWordTiming(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    const tokens: string[] = []
    for (const part of segmenter.segment(trimmed)) {
      const segment = part.segment.trim()
      if (!segment) {
        continue
      }
      if (part.isWordLike || tokens.length === 0) {
        tokens.push(segment)
      } else {
        tokens[tokens.length - 1] += segment
      }
    }
    if (tokens.length > 0) {
      return tokens
    }
  }

  return tokenizeLyricWords(trimmed)
}

function tokenizeWordTimingCharacters(text: string): string[] {
  const tokens: string[] = []
  for (const grapheme of splitLyricGraphemes(text.trim())) {
    if (!grapheme.trim()) {
      continue
    }
    if (/^[\p{P}\p{S}]+$/u.test(grapheme) && tokens.length > 0) {
      tokens[tokens.length - 1] += grapheme
    } else {
      tokens.push(grapheme)
    }
  }
  return tokens
}

function formatClock(value: number): string {
  return formatLrcTimestamp(value)
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
