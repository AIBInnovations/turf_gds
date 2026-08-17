export function validJpegBuffer(suffix = 'document'): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(suffix)]);
}

export function validPngBuffer(suffix = 'document'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(suffix),
  ]);
}

export function validPdfBuffer(suffix = 'document'): Buffer {
  return Buffer.concat([Buffer.from('%PDF-', 'ascii'), Buffer.from(suffix)]);
}

export function validMp4Buffer(suffix = 'document'): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp', 'ascii'),
    Buffer.from(suffix),
  ]);
}

export function mismatchedMagicBytesBuffer(): Buffer {
  return validPngBuffer('claimed-as-a-different-type');
}
