export interface AudioMetadata {
  title?: string
  artist?: string
  cover?: Blob
}

const maxTagBytes = 8 * 1024 * 1024

/** Read the common ID3v2 fields locally so an MP3 can provide its own title, artist and cover. */
export async function readAudioMetadata(file: File): Promise<AudioMetadata> {
  if (!file.type.includes('mpeg') && !file.name.toLowerCase().endsWith('.mp3')) {
    return {}
  }

  const header = new Uint8Array(await file.slice(0, 10).arrayBuffer())
  if (decodeAscii(header.subarray(0, 3)) !== 'ID3' || header.length < 10) {
    return {}
  }

  const version = header[3]
  if (version < 2 || version > 4) {
    return {}
  }

  const tagSize = readSyncSafe(header, 6)
  const byteLength = Math.min(file.size, Math.min(maxTagBytes, tagSize + 10))
  const bytes = new Uint8Array(await file.slice(0, byteLength).arrayBuffer())
  const flags = bytes[5]
  const footerSize = version === 4 && (flags & 0x10) !== 0 ? 10 : 0
  const framesEnd = Math.min(bytes.length - footerSize, tagSize + 10)
  let cursor = 10

  if ((flags & 0x40) !== 0) {
    const extendedSize = version === 3
      ? readUint32(bytes, cursor)
      : readSyncSafe(bytes, cursor)
    cursor += Math.max(0, extendedSize + (version === 3 ? 4 : 0))
  }

  const metadata: AudioMetadata = {}

  while (cursor < framesEnd) {
    const headerSize = version === 2 ? 6 : 10
    if (cursor + headerSize > framesEnd || bytes[cursor] === 0) {
      break
    }

    const idLength = version === 2 ? 3 : 4
    const frameId = decodeAscii(bytes.subarray(cursor, cursor + idLength))
    const frameSize = version === 2
      ? readUint24(bytes, cursor + idLength)
      : version === 4
        ? readSyncSafe(bytes, cursor + idLength)
        : readUint32(bytes, cursor + idLength)
    const frameStart = cursor + headerSize
    const frameEnd = frameStart + frameSize

    if (!frameId.trim() || frameSize <= 0 || frameEnd > framesEnd) {
      break
    }

    const frame = bytes.subarray(frameStart, frameEnd)
    if (frameId === 'TIT2' || frameId === 'TT2') {
      metadata.title = decodeTextFrame(frame)
    } else if (frameId === 'TPE1' || frameId === 'TP1') {
      metadata.artist = decodeTextFrame(frame)
    } else if (frameId === 'APIC' || frameId === 'PIC') {
      metadata.cover ??= decodeCoverFrame(frame, version === 2)
    }

    cursor = frameEnd
  }

  return metadata
}

function decodeCoverFrame(frame: Uint8Array, compact: boolean): Blob | undefined {
  if (frame.length < (compact ? 6 : 5)) {
    return undefined
  }

  const encoding = frame[0]
  let cursor = 1
  let mimeType = 'image/jpeg'

  if (compact) {
    const format = decodeAscii(frame.subarray(cursor, cursor + 3)).toLowerCase()
    mimeType = format === 'png' ? 'image/png' : format === 'gif' ? 'image/gif' : 'image/jpeg'
    cursor += 3
  } else {
    const mimeEnd = findTerminator(frame, cursor, 0)
    const mime = decodeAscii(frame.subarray(cursor, mimeEnd)).trim()
    if (mime.startsWith('image/')) {
      mimeType = mime
    }
    cursor = mimeEnd + 1
  }

  cursor += 1 // picture type
  const descriptionEnd = findTextTerminator(frame, cursor, encoding)
  const imageStart = Math.min(frame.length, descriptionEnd + textTerminatorLength(encoding))

  if (imageStart >= frame.length) {
    return undefined
  }

  return new Blob([frame.slice(imageStart)], { type: mimeType })
}

function decodeTextFrame(frame: Uint8Array): string | undefined {
  if (frame.length < 2) {
    return undefined
  }

  const value = decodeText(frame.subarray(1), frame[0]).replace(/\0/g, '').trim()
  return value || undefined
}

function decodeText(bytes: Uint8Array, encoding: number): string {
  try {
    if (encoding === 0) {
      return new TextDecoder('iso-8859-1').decode(bytes)
    }

    if (encoding === 3) {
      return new TextDecoder('utf-8').decode(bytes)
    }

    if (encoding === 2) {
      return new TextDecoder('utf-16be').decode(bytes)
    }

    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2))
    }

    return new TextDecoder('utf-16le').decode(bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

function findTextTerminator(bytes: Uint8Array, start: number, encoding: number): number {
  if (encoding === 0 || encoding === 3) {
    return findTerminator(bytes, start, 0)
  }

  for (let index = start; index < bytes.length - 1; index += 2) {
    if (bytes[index] === 0 && bytes[index + 1] === 0) {
      return index
    }
  }

  return bytes.length
}

function textTerminatorLength(encoding: number): number {
  return encoding === 0 || encoding === 3 ? 1 : 2
}

function findTerminator(bytes: Uint8Array, start: number, value: number): number {
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === value) {
      return index
    }
  }

  return bytes.length
}

function readSyncSafe(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
}

function decodeAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes)
}
