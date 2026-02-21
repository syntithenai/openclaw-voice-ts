export type WavDecodeResult = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
};

function readString(buf: Buffer, offset: number, length: number): string {
  return buf.toString('ascii', offset, offset + length);
}

export function decodeWav(buffer: Buffer): WavDecodeResult {
  if (buffer.length < 44 || readString(buffer, 0, 4) !== 'RIFF' || readString(buffer, 8, 4) !== 'WAVE') {
    throw new Error('Invalid WAV header');
  }

  let offset = 12;
  let fmtFound = false;
  let dataFound = false;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let audioFormat = 1;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = readString(buffer, offset, 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ') {
      audioFormat = buffer.readUInt16LE(chunkDataOffset);
      channels = buffer.readUInt16LE(chunkDataOffset + 2);
      sampleRate = buffer.readUInt32LE(chunkDataOffset + 4);
      bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
      fmtFound = true;
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      dataFound = true;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!fmtFound || !dataFound) {
    throw new Error('Invalid WAV file: missing fmt or data chunk');
  }

  if (audioFormat !== 1) {
    throw new Error(`Unsupported WAV format: ${audioFormat}`);
  }

  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  }

  const pcm = buffer.slice(dataOffset, dataOffset + dataSize);

  return { sampleRate, channels, bitsPerSample, pcm };
}

export function encodeWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number = 1,
  bitsPerSample: number = 16
): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
