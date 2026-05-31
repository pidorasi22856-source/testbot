'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// kiro_eventstream.js — minimal AWS EventStream (vnd.amazon.eventstream) binary
// frame parser. Adapted from OmniRoute open-sse/executors/kiro.ts.
//
// Frame layout (big-endian):
//   [0..3]   totalLength
//   [4..7]   headersLength
//   [8..11]  prelude CRC32
//   [12 .. 12+headersLength)  headers
//   [.. totalLength-4)        payload (JSON)
//   [last 4] message CRC32
// We tolerate/skip CRC mismatches rather than failing the stream.
// ─────────────────────────────────────────────────────────────────────────────

// Incremental parser: feed Buffers, get back an array of decoded events
// ({ type, payload }) each time enough bytes are buffered.
class EventStreamParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const events = [];
    let guard = 0;
    while (this.buf.length >= 12 && guard < 10000) {
      guard++;
      const totalLength = this.buf.readUInt32BE(0);
      if (totalLength < 16 || totalLength > 16 * 1024 * 1024) {
        // Corrupt framing — drop one byte and resync.
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < totalLength) break; // wait for more bytes

      const frame = this.buf.subarray(0, totalLength);
      this.buf = this.buf.subarray(totalLength);

      const ev = parseFrame(frame);
      if (ev) events.push(ev);
    }
    return events;
  }
}

function parseFrame(data) {
  try {
    const totalLength   = data.readUInt32BE(0);
    const headersLength = data.readUInt32BE(4);
    // prelude CRC at [8..11] — skipped (we tolerate)

    const headers = {};
    let offset = 12;
    const headerEnd = 12 + headersLength;
    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset]; offset += 1;
      if (offset + nameLen > data.length) break;
      const name = data.toString('utf8', offset, offset + nameLen);
      offset += nameLen;
      const headerType = data[offset]; offset += 1;
      if (headerType === 7) { // string
        const valueLen = data.readUInt16BE(offset); offset += 2;
        if (offset + valueLen > data.length) break;
        headers[name] = data.toString('utf8', offset, offset + valueLen);
        offset += valueLen;
      } else {
        break; // unsupported header type — stop header parse
      }
    }

    const payloadStart = 12 + headersLength;
    const payloadEnd   = data.length - 4; // exclude message CRC
    let payload = null;
    if (payloadEnd > payloadStart) {
      const str = data.toString('utf8', payloadStart, payloadEnd);
      if (str && str.trim()) {
        try { payload = JSON.parse(str); }
        catch { payload = { raw: str }; }
      }
    }

    return { type: headers[':event-type'] || '', headers, payload };
  } catch {
    return null;
  }
}

module.exports = { EventStreamParser, parseFrame };
