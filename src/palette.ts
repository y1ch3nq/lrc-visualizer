export interface VisualizerPalette {
  id: string
  name: string
  description: string
  descriptionEn?: string
  backgroundColor: string
  lyricColor: string
  progressColor: string
  nextColor: string
  metaColor: string
}

export interface ExtractedPaletteResult {
  palette: VisualizerPalette
  swatches: string[]
}

interface OklabColor {
  l: number
  a: number
  b: number
}

interface Cluster extends OklabColor {
  count: number
}

export const palettePresets: VisualizerPalette[] = [
  {
    id: 'sunset-bloom',
    name: 'Sunset Bloom',
    description: '暖棕、橙红与奶油白',
    descriptionEn: 'Warm brown, orange-red & cream',
    backgroundColor: '#AD7338',
    lyricColor: '#FFF7EC',
    progressColor: '#FF7130',
    nextColor: '#E5C29E',
    metaColor: '#F3D7BB',
  },
  {
    id: 'apricot-mist',
    name: 'Apricot Mist',
    description: '杏粉、珊瑚与柔和象牙色',
    descriptionEn: 'Apricot pink, coral & soft ivory',
    backgroundColor: '#D99A7A',
    lyricColor: '#FFF8F0',
    progressColor: '#C94E43',
    nextColor: '#F2D0BB',
    metaColor: '#FFE3D1',
  },
  {
    id: 'sage-paper',
    name: 'Sage Paper',
    description: '鼠尾草绿与纸张米色',
    descriptionEn: 'Sage green & paper beige',
    backgroundColor: '#78866B',
    lyricColor: '#FFFBEF',
    progressColor: '#D9E6A2',
    nextColor: '#CCD2B8',
    metaColor: '#E7E4CF',
  },
  {
    id: 'glacier-glass',
    name: 'Glacier Glass',
    description: '冰川蓝与冷白高光',
    descriptionEn: 'Glacier blue & cool white highlights',
    backgroundColor: '#527B8F',
    lyricColor: '#F6FCFF',
    progressColor: '#92E4E8',
    nextColor: '#B7D2DA',
    metaColor: '#D8E9ED',
  },
  {
    id: 'plum-velvet',
    name: 'Plum Velvet',
    description: '深梅紫与柔粉高光',
    descriptionEn: 'Deep plum & soft pink highlights',
    backgroundColor: '#51384E',
    lyricColor: '#FFF5FC',
    progressColor: '#F08AB8',
    nextColor: '#C8A6BF',
    metaColor: '#E3C8DB',
  },
  {
    id: 'ink-cream',
    name: 'Ink & Cream',
    description: '墨色、奶油白与金色强调',
    descriptionEn: 'Ink, cream & gold accents',
    backgroundColor: '#272A31',
    lyricColor: '#FFF9E9',
    progressColor: '#EBC878',
    nextColor: '#B9B4A5',
    metaColor: '#DED6C2',
  },
]

export async function extractImagePalette(file: File): Promise<ExtractedPaletteResult> {
  const image = await loadImageSource(file)
  const maxDimension = 144
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  if (!ctx) {
    image.close()
    throw new Error('无法读取图片像素')
  }

  ctx.drawImage(image.source, 0, 0, width, height)
  image.close()

  const pixels = ctx.getImageData(0, 0, width, height).data
  return extractPaletteFromRgba(pixels, width, height)
}

export function extractPaletteFromRgba(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
): ExtractedPaletteResult {
  const samples: OklabColor[] = []
  const pixelCount = width * height
  const stride = Math.max(1, Math.ceil(pixelCount / 7_000))

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += stride) {
    const offset = pixelIndex * 4
    if (pixels[offset + 3] < 180) {
      continue
    }

    samples.push(rgbToOklab(pixels[offset], pixels[offset + 1], pixels[offset + 2]))
  }

  if (samples.length < 8) {
    throw new Error('图片中没有足够的有效颜色')
  }

  const clusters = clusterColors(samples, Math.min(6, samples.length))
    .filter((cluster) => cluster.count > 0)
    .sort((a, b) => b.count - a.count)
  const swatches = deduplicateColors(clusters.map(oklabToHex), 6)
  const backgroundColor = swatches[0] ?? '#7A6655'
  const lyricColor = chooseReadableColor(backgroundColor, swatches)
  const progressColor = chooseAccentColor(backgroundColor, lyricColor, swatches)

  return {
    swatches,
    palette: {
      id: `image-${Date.now()}`,
      name: '图片智能配色',
      description: '根据图片的感知色彩聚类生成',
      descriptionEn: 'Generated from perceptual color clusters in the image',
      backgroundColor,
      lyricColor,
      progressColor,
      nextColor: mixHex(backgroundColor, lyricColor, 0.56),
      metaColor: mixHex(backgroundColor, lyricColor, 0.76),
    },
  }
}

async function loadImageSource(file: File): Promise<{
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}> {
  if ('createImageBitmap' in globalThis) {
    try {
      const bitmap = await createImageBitmap(file)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // Some browser/codec combinations expose createImageBitmap but reject a valid image.
    }
  }

  const url = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  image.src = url

  try {
    await image.decode()
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

// Deterministic k-means in OKLab keeps visually similar colors in the same cluster.
function clusterColors(samples: OklabColor[], clusterCount: number): Cluster[] {
  const average = samples.reduce(
    (total, sample) => ({ l: total.l + sample.l, a: total.a + sample.a, b: total.b + sample.b }),
    { l: 0, a: 0, b: 0 },
  )
  average.l /= samples.length
  average.a /= samples.length
  average.b /= samples.length

  const centroids: Cluster[] = [{ ...closestColor(samples, average), count: 0 }]

  while (centroids.length < clusterCount) {
    let bestSample = samples[centroids.length % samples.length]
    let bestDistance = -1

    for (const sample of samples) {
      const nearestDistance = Math.min(...centroids.map((centroid) => colorDistanceSquared(sample, centroid)))
      const chromaBoost = 1 + Math.hypot(sample.a, sample.b) * 0.8
      const score = nearestDistance * chromaBoost
      if (score > bestDistance) {
        bestDistance = score
        bestSample = sample
      }
    }

    centroids.push({ ...bestSample, count: 0 })
  }

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const totals = centroids.map(() => ({ l: 0, a: 0, b: 0, count: 0 }))

    for (const sample of samples) {
      let clusterIndex = 0
      let nearestDistance = Number.POSITIVE_INFINITY

      centroids.forEach((centroid, index) => {
        const distance = colorDistanceSquared(sample, centroid)
        if (distance < nearestDistance) {
          nearestDistance = distance
          clusterIndex = index
        }
      })

      const total = totals[clusterIndex]
      total.l += sample.l
      total.a += sample.a
      total.b += sample.b
      total.count += 1
    }

    totals.forEach((total, index) => {
      if (total.count > 0) {
        centroids[index] = {
          l: total.l / total.count,
          a: total.a / total.count,
          b: total.b / total.count,
          count: total.count,
        }
      }
    })
  }

  return centroids
}

function chooseReadableColor(background: string, candidates: string[]): string {
  const backgroundLuminance = relativeLuminance(hexToRgb(background))
  const prefersLightText = backgroundLuminance < 0.42
  const derivedCandidates = [...candidates, '#FFFDF8', '#111217']
  const tonalCandidates = derivedCandidates.filter((color) => {
    const luminance = relativeLuminance(hexToRgb(color))
    return prefersLightText ? luminance > 0.62 : luminance < 0.18
  })

  return (tonalCandidates.length > 0 ? tonalCandidates : derivedCandidates).sort(
    (a, b) => contrastRatio(b, background) - contrastRatio(a, background),
  )[0]
}

function chooseAccentColor(background: string, lyric: string, candidates: string[]): string {
  const scored = candidates
    .filter((color) => color !== background && color !== lyric)
    .map((color) => {
      const { saturation } = rgbToHsl(hexToRgb(color))
      const backgroundContrast = Math.min(contrastRatio(color, background), 7) / 7
      const backgroundDistance = rgbDistance(hexToRgb(color), hexToRgb(background)) / 441.67
      const lyricDistance = rgbDistance(hexToRgb(color), hexToRgb(lyric)) / 441.67
      return { color, score: saturation * 0.62 + backgroundDistance * 0.2 + backgroundContrast * 0.1 + lyricDistance * 0.08 }
    })
    .sort((a, b) => b.score - a.score)

  const extracted = scored[0]?.color
  if (extracted && rgbDistance(hexToRgb(extracted), hexToRgb(background)) >= 26) {
    return extracted
  }

  return contrastRatio('#FF7A38', background) >= 1.7 ? '#FF7A38' : mixHex(background, lyric, 0.72)
}

function deduplicateColors(colors: string[], limit: number): string[] {
  const result: string[] = []

  for (const color of colors) {
    if (result.every((existing) => rgbDistance(hexToRgb(existing), hexToRgb(color)) > 34)) {
      result.push(color)
    }
    if (result.length >= limit) {
      break
    }
  }

  return result
}

function closestColor(samples: OklabColor[], target: OklabColor): OklabColor {
  return samples.reduce((closest, sample) => (
    colorDistanceSquared(sample, target) < colorDistanceSquared(closest, target) ? sample : closest
  ))
}

function colorDistanceSquared(first: OklabColor, second: OklabColor): number {
  return (first.l - second.l) ** 2 + (first.a - second.a) ** 2 + (first.b - second.b) ** 2
}

function rgbToOklab(red: number, green: number, blue: number): OklabColor {
  const r = srgbToLinear(red / 255)
  const g = srgbToLinear(green / 255)
  const b = srgbToLinear(blue / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function oklabToHex(color: OklabColor): string {
  const l = color.l + 0.3963377774 * color.a + 0.2158037573 * color.b
  const m = color.l - 0.1055613458 * color.a - 0.0638541728 * color.b
  const s = color.l - 0.0894841775 * color.a - 1.291485548 * color.b
  const l3 = l ** 3
  const m3 = m ** 3
  const s3 = s ** 3

  return rgbToHex({
    red: linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3) * 255,
    green: linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3) * 255,
    blue: linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3) * 255,
  })
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(hexToRgb(first))
  const secondLuminance = relativeLuminance(hexToRgb(second))
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(color: RgbColor): number {
  const channels = [color.red, color.green, color.blue].map((value) => srgbToLinear(value / 255))
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

interface RgbColor {
  red: number
  green: number
  blue: number
}

function hexToRgb(color: string): RgbColor {
  const normalized = color.replace('#', '').padEnd(6, '0').slice(0, 6)
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

function rgbToHex(color: RgbColor): string {
  const channel = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`.toUpperCase()
}

function mixHex(first: string, second: string, amount: number): string {
  const start = hexToRgb(first)
  const end = hexToRgb(second)
  const mix = (from: number, to: number) => from + (to - from) * amount
  return rgbToHex({
    red: mix(start.red, end.red),
    green: mix(start.green, end.green),
    blue: mix(start.blue, end.blue),
  })
}

function rgbToHsl(color: RgbColor): { saturation: number } {
  const red = color.red / 255
  const green = color.green / 255
  const blue = color.blue / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  const delta = max - min
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  return { saturation: Number.isFinite(saturation) ? saturation : 0 }
}

function rgbDistance(first: RgbColor, second: RgbColor): number {
  return Math.hypot(first.red - second.red, first.green - second.green, first.blue - second.blue)
}
