export interface Mp4MuxSample {
  data: Uint8Array
  durationUs: number
  keyFrame?: boolean
}

interface Mp4MuxInput {
  videoSamples: Mp4MuxSample[]
  audioSamples: Mp4MuxSample[]
  width: number
  height: number
  frameRate: number
  durationUs: number
  audioSampleRate: number
  audioChannels: number
  videoDecoderConfig: Uint8Array
  audioDecoderConfig: Uint8Array
}

const movieTimescale = 1_000
const videoTimescale = 90_000
const matrix = concatBytes([
  uint32(0x00010000), uint32(0), uint32(0),
  uint32(0), uint32(0x00010000), uint32(0),
  uint32(0), uint32(0), uint32(0x40000000),
])

export function muxMp4(input: Mp4MuxInput): Blob {
  if (input.videoSamples.length === 0 || input.audioSamples.length === 0) {
    throw new Error('MP4 封装缺少视频或音频数据')
  }

  const ftyp = box('ftyp', ascii('isom'), uint32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'))
  const videoTrack = trimTrackToDuration(
    input.videoSamples,
    input.videoSamples.map((sample) => toTimescale(sample.durationUs, videoTimescale)),
    toTimescale(input.durationUs, videoTimescale),
  )
  const audioTrack = trimTrackToDuration(
    input.audioSamples,
    input.audioSamples.map((sample) => toTimescale(sample.durationUs, input.audioSampleRate)),
    toTimescale(input.durationUs, input.audioSampleRate),
  )
  const videoDataSize = sumSampleSizes(videoTrack.samples)
  const audioDataSize = sumSampleSizes(audioTrack.samples)
  const mdatHeader = createBoxHeader('mdat', 8 + videoDataSize + audioDataSize)
  const videoChunkOffset = ftyp.byteLength + mdatHeader.byteLength
  const audioChunkOffset = videoChunkOffset + videoDataSize

  const videoDurations = videoTrack.durations
  const audioDurations = audioTrack.durations
  const videoDuration = sumNumbers(videoDurations)
  const audioDuration = sumNumbers(audioDurations)
  const movieDuration = Math.max(
    convertTimescale(videoDuration, videoTimescale, movieTimescale),
    convertTimescale(audioDuration, input.audioSampleRate, movieTimescale),
  )

  const moov = box(
    'moov',
    createMovieHeader(movieDuration),
    createTrack({
      id: 1,
      type: 'video',
      movieDuration: convertTimescale(videoDuration, videoTimescale, movieTimescale),
      mediaTimescale: videoTimescale,
      mediaDuration: videoDuration,
      width: input.width,
      height: input.height,
      sampleEntry: createAvcSampleEntry(input.width, input.height, input.videoDecoderConfig),
      samples: videoTrack.samples,
      sampleDurations: videoDurations,
      chunkOffset: videoChunkOffset,
    }),
    createTrack({
      id: 2,
      type: 'audio',
      movieDuration: convertTimescale(audioDuration, input.audioSampleRate, movieTimescale),
      mediaTimescale: input.audioSampleRate,
      mediaDuration: audioDuration,
      width: 0,
      height: 0,
      sampleEntry: createAacSampleEntry(
        input.audioSampleRate,
        input.audioChannels,
        input.audioDecoderConfig,
      ),
      samples: audioTrack.samples,
      sampleDurations: audioDurations,
      chunkOffset: audioChunkOffset,
    }),
  )

  return new Blob([
    toArrayBuffer(ftyp),
    toArrayBuffer(mdatHeader),
    ...videoTrack.samples.map((sample) => toArrayBuffer(sample.data)),
    ...audioTrack.samples.map((sample) => toArrayBuffer(sample.data)),
    toArrayBuffer(moov),
  ], { type: 'video/mp4' })
}

function createMovieHeader(duration: number): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    uint32(0),
    uint32(0),
    uint32(movieTimescale),
    uint32(duration),
    uint32(0x00010000),
    uint16(0x0100),
    zeros(10),
    matrix,
    zeros(24),
    uint32(3),
  )
}

function createTrack(input: {
  id: number
  type: 'video' | 'audio'
  movieDuration: number
  mediaTimescale: number
  mediaDuration: number
  width: number
  height: number
  sampleEntry: Uint8Array
  samples: Mp4MuxSample[]
  sampleDurations: number[]
  chunkOffset: number
}): Uint8Array {
  const isAudio = input.type === 'audio'

  return box(
    'trak',
    fullBox(
      'tkhd',
      0,
      0x000007,
      uint32(0),
      uint32(0),
      uint32(input.id),
      uint32(0),
      uint32(input.movieDuration),
      zeros(8),
      uint16(0),
      uint16(0),
      uint16(isAudio ? 0x0100 : 0),
      uint16(0),
      matrix,
      uint32(input.width * 65536),
      uint32(input.height * 65536),
    ),
    box(
      'mdia',
      fullBox(
        'mdhd',
        0,
        0,
        uint32(0),
        uint32(0),
        uint32(input.mediaTimescale),
        uint32(input.mediaDuration),
        uint16(0x55c4),
        uint16(0),
      ),
      fullBox(
        'hdlr',
        0,
        0,
        uint32(0),
        ascii(isAudio ? 'soun' : 'vide'),
        zeros(12),
        ascii(isAudio ? 'SoundHandler\0' : 'VideoHandler\0'),
      ),
      box(
        'minf',
        isAudio
          ? fullBox('smhd', 0, 0, uint16(0), uint16(0))
          : fullBox('vmhd', 0, 1, uint16(0), uint16(0), uint16(0), uint16(0)),
        box(
          'dinf',
          fullBox('dref', 0, 0, uint32(1), fullBox('url ', 0, 1)),
        ),
        createSampleTable(input),
      ),
    ),
  )
}

function createSampleTable(input: {
  type: 'video' | 'audio'
  sampleEntry: Uint8Array
  samples: Mp4MuxSample[]
  sampleDurations: number[]
  chunkOffset: number
}): Uint8Array {
  const timeToSampleEntries = runLengthEncode(input.sampleDurations)
  const keyFrames = input.type === 'video'
    ? input.samples.flatMap((sample, index) => sample.keyFrame ? [index + 1] : [])
    : []

  const boxes = [
    fullBox('stsd', 0, 0, uint32(1), input.sampleEntry),
    fullBox(
      'stts',
      0,
      0,
      uint32(timeToSampleEntries.length),
      ...timeToSampleEntries.flatMap((entry) => [uint32(entry.count), uint32(entry.value)]),
    ),
    fullBox('stsc', 0, 0, uint32(1), uint32(1), uint32(input.samples.length), uint32(1)),
    fullBox(
      'stsz',
      0,
      0,
      uint32(0),
      uint32(input.samples.length),
      ...input.samples.map((sample) => uint32(sample.data.byteLength)),
    ),
    fullBox('stco', 0, 0, uint32(1), uint32(input.chunkOffset)),
  ]

  if (keyFrames.length > 0 && keyFrames.length !== input.samples.length) {
    boxes.push(fullBox('stss', 0, 0, uint32(keyFrames.length), ...keyFrames.map(uint32)))
  }

  return box('stbl', ...boxes)
}

function createAvcSampleEntry(width: number, height: number, decoderConfig: Uint8Array): Uint8Array {
  const compressorName = new Uint8Array(32)
  const name = ascii('LRC Visualizer')
  compressorName[0] = Math.min(31, name.byteLength)
  compressorName.set(name.subarray(0, 31), 1)

  return box(
    'avc1',
    zeros(6),
    uint16(1),
    uint16(0),
    uint16(0),
    zeros(12),
    uint16(width),
    uint16(height),
    uint32(0x00480000),
    uint32(0x00480000),
    uint32(0),
    uint16(1),
    compressorName,
    uint16(0x0018),
    uint16(0xffff),
    box('avcC', decoderConfig),
  )
}

function createAacSampleEntry(
  sampleRate: number,
  channels: number,
  decoderConfig: Uint8Array,
): Uint8Array {
  return box(
    'mp4a',
    zeros(6),
    uint16(1),
    zeros(8),
    uint16(channels),
    uint16(16),
    uint16(0),
    uint16(0),
    uint32(sampleRate * 65536),
    createEsds(decoderConfig),
  )
}

function createEsds(decoderConfig: Uint8Array): Uint8Array {
  const decoderSpecificInfo = descriptor(0x05, decoderConfig)
  const decoderConfigDescriptor = descriptor(
    0x04,
    uint8(0x40),
    uint8(0x15),
    uint24(0),
    uint32(192_000),
    uint32(192_000),
    decoderSpecificInfo,
  )
  const slConfigDescriptor = descriptor(0x06, uint8(0x02))
  const esDescriptor = descriptor(
    0x03,
    uint16(2),
    uint8(0),
    decoderConfigDescriptor,
    slConfigDescriptor,
  )

  return fullBox('esds', 0, 0, esDescriptor)
}

function descriptor(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const payload = concatBytes(parts)
  return concatBytes([uint8(tag), descriptorLength(payload.byteLength), payload])
}

function descriptorLength(length: number): Uint8Array {
  const bytes = [length & 0x7f]
  let remaining = length >> 7

  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80)
    remaining >>= 7
  }

  return new Uint8Array(bytes)
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, uint8(version), uint24(flags), ...parts)
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concatBytes(parts)
  return concatBytes([createBoxHeader(type, payload.byteLength + 8), payload])
}

function createBoxHeader(type: string, size: number): Uint8Array {
  if (size > 0xffffffff) {
    throw new Error('MP4 文件过大，超过当前封装器限制')
  }

  return concatBytes([uint32(size), ascii(type)])
}

function runLengthEncode(values: number[]): Array<{ count: number; value: number }> {
  const result: Array<{ count: number; value: number }> = []

  values.forEach((value) => {
    const previous = result.at(-1)
    if (previous?.value === value) {
      previous.count += 1
    } else {
      result.push({ count: 1, value })
    }
  })

  return result
}

function trimTrackToDuration(
  samples: Mp4MuxSample[],
  durations: number[],
  targetDuration: number,
): { samples: Mp4MuxSample[]; durations: number[] } {
  const trimmedSamples: Mp4MuxSample[] = []
  const trimmedDurations: number[] = []
  let remaining = Math.max(1, targetDuration)

  for (let index = 0; index < samples.length && remaining > 0; index += 1) {
    const duration = Math.max(1, durations[index] ?? 1)
    const appliedDuration = Math.min(duration, remaining)
    trimmedSamples.push(samples[index])
    trimmedDurations.push(appliedDuration)
    remaining -= appliedDuration
  }

  if (trimmedDurations.length === 0) {
    throw new Error('MP4 封装轨道没有可用采样')
  }

  // Encoder output may be a few samples short because of its final packet.
  // Keep the container timeline exact by extending that one final sample rather
  // than changing playback speed for the whole track.
  if (remaining > 0) {
    trimmedDurations[trimmedDurations.length - 1] += remaining
  }

  return { samples: trimmedSamples, durations: trimmedDurations }
}

function toTimescale(durationUs: number, timescale: number): number {
  return Math.max(1, Math.round((durationUs * timescale) / 1_000_000))
}

function convertTimescale(value: number, from: number, to: number): number {
  return Math.max(1, Math.round((value * to) / from))
}

function sumSampleSizes(samples: Mp4MuxSample[]): number {
  return samples.reduce((sum, sample) => sum + sample.data.byteLength, 0)
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0)
}

function uint8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff])
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, false)
  return bytes
}

function uint24(value: number): Uint8Array {
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff])
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length)
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0

  parts.forEach((part) => {
    result.set(part, offset)
    offset += part.byteLength
  })

  return result
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
