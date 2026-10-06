// Byte-level reader and writer. Every read is bounds-checked; every failure is a CodecError.

/** The one error type a decoder ever throws for bad input. */
export class CodecError extends Error {
  override name = "CodecError";
}

export class Writer {
  private buf = new Uint8Array(64);
  private len = 0;

  private grow(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(n: number) {
    this.grow(1);
    this.buf[this.len++] = n & 0xff;
  }

  /** Unsigned big-endian integer of 2 or 3 bytes. */
  uint(n: number, bytes: 2 | 3) {
    this.grow(bytes);
    for (let i = bytes - 1; i >= 0; i--) this.buf[this.len++] = Math.floor(n / 2 ** (8 * i)) & 0xff;
  }

  /** Unsigned LEB128, any safe integer. */
  varint(n: number) {
    if (!Number.isSafeInteger(n) || n < 0) throw new CodecError(`varint out of range: ${n}`);
    this.grow(8);
    while (n >= 0x80) {
      this.buf[this.len++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.len++] = n;
  }

  /** Signed integer as a zigzag varint (0, -1, 1, -2, ... → 0, 1, 2, 3, ...). */
  zigzag(n: number) {
    this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  raw(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class Reader {
  private off = 0;
  constructor(private readonly b: Uint8Array) {}

  private need(n: number) {
    if (this.off + n > this.b.length) throw new CodecError("truncated");
  }

  u8(): number {
    this.need(1);
    return this.b[this.off++]!;
  }

  uint(bytes: 2 | 3): number {
    this.need(bytes);
    let v = 0;
    for (let i = 0; i < bytes; i++) v = v * 256 + this.b[this.off++]!;
    return v;
  }

  /** At most 8 bytes (56 bits): anything longer is refused, never silently wrapped. */
  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) break;
        return value;
      }
      scale *= 0x80;
    }
    throw new CodecError("varint too long");
  }

  zigzag(): number {
    const z = this.varint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  /** Refuses trailing bytes: a frame is exactly as long as it says. */
  end() {
    if (this.off !== this.b.length) throw new CodecError("trailing bytes");
  }
}
