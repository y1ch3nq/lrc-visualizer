export type UiLanguage = 'zh' | 'en'

export function pickUiText(language: UiLanguage, chinese: string, english: string): string {
  return language === 'en' ? english : chinese
}

export function getInitialUiLanguage(): UiLanguage {
  try {
    return window.localStorage.getItem('lrc-visualizer-language') === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

const knownErrorTranslations = new Map<string, string>([
  ['当前浏览器不支持音频分析', 'This browser does not support audio analysis'],
  ['当前浏览器不支持纯前端音频分析', 'This browser does not support in-browser audio analysis'],
  ['MP4 封装缺少视频或音频数据', 'The MP4 export is missing video or audio data'],
  ['MP4 文件过大，超过当前封装器限制', 'The MP4 is too large for the current muxer'],
  ['MP4 封装轨道没有可用采样', 'The MP4 track contains no usable samples'],
  ['逐词 PNG 序列仅适用于黑白歌词模式', 'Word-by-word PNG sequences are only available in TikTok monochrome mode'],
  ['所选片段内没有可导出的歌词状态', 'The selected range contains no exportable lyric states'],
  ['无法创建 PNG 导出画布', 'Unable to create the PNG export canvas'],
  ['PNG 编码失败', 'PNG encoding failed'],
  ['无法读取图片像素', 'Unable to read image pixels'],
  ['图片中没有足够的有效颜色', 'The image does not contain enough usable colors'],
  ['当前浏览器不支持 WebCodecs 快速导出', 'This browser does not support fast WebCodecs export'],
  ['当前浏览器不支持离线音频编码', 'This browser does not support offline audio encoding'],
  ['当前浏览器不支持带透明通道的 VP9/Opus 直接导出', 'This browser cannot directly export VP9/Opus with transparency'],
  ['当前浏览器没有可用的 H.264/AAC 或 VP8/VP9/Opus 直接编码组合', 'No supported H.264/AAC or VP8/VP9/Opus encoder combination is available'],
  ['快速导出不可用', 'Fast export is unavailable'],
  ['快速导出编码器初始化失败', 'Unable to initialize the fast export encoder'],
  ['导出音频读取失败', 'Unable to read the audio for export'],
  ['当前浏览器不支持音频解码', 'This browser does not support audio decoding'],
  ['无法创建离屏导出画布', 'Unable to create the offscreen export canvas'],
  ['编码器没有生成可用的媒体帧', 'The encoder produced no usable media frames'],
  ['编码过程中断', 'Encoding was interrupted'],
  ['WebM 数据过大，无法封装', 'The WebM data is too large to mux'],
])

export function localizeErrorMessage(message: string, language: UiLanguage): string {
  if (language !== 'en') {
    return message
  }

  const exact = knownErrorTranslations.get(message)
  if (exact) {
    return exact
  }

  const frameLimit = message.match(/^当前片段会生成 (\d+) 张 PNG，超过 (\d+) 张上限；请缩短导出范围$/)
  if (frameLimit) {
    return `This range would create ${frameLimit[1]} PNG files, above the ${frameLimit[2]}-file limit. Please shorten the export range.`
  }

  return message
}
