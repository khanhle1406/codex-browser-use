/**
 * Single-allocation JSON frame encoder and O(n) chunked stream reader
 * for 4-byte uint32 length-prefixed framing.
 */

/**
 * Serialize and frame a JSON message in a single Buffer allocation.
 * @param {unknown} message
 * @param {{littleEndian:boolean, maxFrameBytes:number, overflowError?:string}} options
 * @returns {Buffer}
 */
export function encodeFrame(message, {
  littleEndian,
  maxFrameBytes,
  overflowError = "Message exceeds frame limit",
}) {
  const json = JSON.stringify(message);
  const byteLen = Buffer.byteLength(json, "utf8");
  if (byteLen > maxFrameBytes) {
    throw new Error(overflowError);
  }
  const packet = Buffer.allocUnsafe(4 + byteLen);
  if (littleEndian) packet.writeUInt32LE(byteLen, 0);
  else packet.writeUInt32BE(byteLen, 0);
  packet.write(json, 4, byteLen, "utf8");
  return packet;
}

/**
 * Stateful O(n) reader for 4-byte length-prefixed streams without repeated Buffer.concat copies.
 */
export class FrameReader {
  /**
   * @param {{littleEndian:boolean, maxFrameBytes:number, maxBufferedBytes?:number, overflowError?:string, lengthError?:string}} options
   */
  constructor({
    littleEndian,
    maxFrameBytes,
    maxBufferedBytes = 2 * (maxFrameBytes + 4),
    overflowError = "Input frame buffer exceeds limit",
    lengthError = "Invalid frame length",
  }) {
    this.littleEndian = Boolean(littleEndian);
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.overflowError = overflowError;
    this.lengthError = lengthError;
    /** @type {Buffer[]} */
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.bufferedBytes = 0;
    this.headerScratch = Buffer.allocUnsafe(4);
  }

  /** @param {Buffer} chunk @returns {void} */
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    if (this.bufferedBytes + chunk.length > this.maxBufferedBytes) {
      throw new Error(this.overflowError);
    }
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
  }

  /** @returns {Buffer | null} */
  nextFrame() {
    if (this.bufferedBytes < 4) return null;
    const length = this.#peekLength();
    if (length < 1 || length > this.maxFrameBytes) {
      throw new Error(this.lengthError);
    }
    if (this.bufferedBytes < 4 + length) return null;

    this.#advance(4);

    const head = this.chunks[this.headIndex];
    if (head.length - this.headOffset >= length) {
      const frame = head.subarray(this.headOffset, this.headOffset + length);
      this.#advance(length);
      this.#compact();
      return frame;
    }

    const frame = Buffer.allocUnsafe(length);
    let written = 0;
    this.bufferedBytes -= length;
    while (written < length) {
      const current = this.chunks[this.headIndex];
      const avail = current.length - this.headOffset;
      const take = Math.min(length - written, avail);
      current.copy(frame, written, this.headOffset, this.headOffset + take);
      written += take;
      this.headOffset += take;
      if (this.headOffset >= current.length) {
        this.headIndex += 1;
        this.headOffset = 0;
      }
    }
    this.#compact();
    return frame;
  }

  /** @returns {number} */
  #peekLength() {
    const head = this.chunks[this.headIndex];
    if (head.length - this.headOffset >= 4) {
      return this.littleEndian
        ? head.readUInt32LE(this.headOffset)
        : head.readUInt32BE(this.headOffset);
    }
    let idx = this.headIndex;
    let off = this.headOffset;
    let filled = 0;
    while (filled < 4) {
      const current = this.chunks[idx];
      const take = Math.min(4 - filled, current.length - off);
      current.copy(this.headerScratch, filled, off, off + take);
      filled += take;
      off += take;
      if (off >= current.length) {
        idx += 1;
        off = 0;
      }
    }
    return this.littleEndian
      ? this.headerScratch.readUInt32LE(0)
      : this.headerScratch.readUInt32BE(0);
  }

  /** @param {number} count @returns {void} */
  #advance(count) {
    let rem = count;
    this.bufferedBytes -= rem;
    while (rem > 0) {
      const current = this.chunks[this.headIndex];
      const avail = current.length - this.headOffset;
      if (rem < avail) {
        this.headOffset += rem;
        rem = 0;
      } else {
        rem -= avail;
        this.headIndex += 1;
        this.headOffset = 0;
      }
    }
  }

  /** @returns {void} */
  #compact() {
    if (this.headIndex >= this.chunks.length) {
      this.chunks.length = 0;
      this.headIndex = 0;
      this.headOffset = 0;
    } else if (this.headIndex >= 64) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}
