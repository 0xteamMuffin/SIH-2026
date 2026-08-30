const MAGIC = Buffer.from("SIHPDF01", "ascii");

export function encodeRenderedPages(metadata, images) {
  const manifest = Buffer.from(JSON.stringify(metadata), "utf8");
  const manifestLength = Buffer.allocUnsafe(4);
  manifestLength.writeUInt32BE(manifest.byteLength);
  const parts = [MAGIC, manifestLength, manifest];
  for (const image of images) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(image.byteLength);
    parts.push(length, Buffer.from(image));
  }
  return Buffer.concat(parts);
}

export function hasPdfSignature(bytes) {
  return bytes.byteLength >= 5 && Buffer.from(bytes.buffer, bytes.byteOffset, 5).equals(Buffer.from("%PDF-", "ascii"));
}
