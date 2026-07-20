// Tiny base64 helpers (pure JS, no runtime assumptions) for moving media
// between data URLs, Convex file storage Blobs, and Gemini inlineData parts.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    out += b === undefined ? "=" : ALPHABET[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    out += c === undefined ? "=" : ALPHABET[c & 63];
  }
  return out;
}

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET[i]] = i;

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n =
      (REVERSE[clean[i]] << 18) |
      (REVERSE[clean[i + 1]] << 12) |
      ((REVERSE[clean[i + 2]] ?? 0) << 6) |
      (REVERSE[clean[i + 3]] ?? 0);
    out[o++] = (n >> 16) & 255;
    if (clean[i + 2] !== undefined) out[o++] = (n >> 8) & 255;
    if (clean[i + 3] !== undefined) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

// "data:image/jpeg;base64,...." -> { mimeType, data }
export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  return m
    ? { mimeType: m[1], data: m[2] }
    : { mimeType: "image/jpeg", data: dataUrl.split(",")[1] ?? dataUrl };
}
