import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

const LF = 0x0a;
const CR = 0x0d;
const DOUBLE_QUOTE = 0x22;
const BACKSLASH = 0x5c;

export interface JsonRpcFrameMetadata {
  id?: RequestId;
  hasId: boolean;
  method?: string;
  hasResult: boolean;
  hasError: boolean;
  isRequest: boolean;
  isResponse: boolean;
}

export class JsonRpcLineBuffer {
  private chunks: Buffer[] = [];
  private headOffset = 0;
  private bufferedBytes = 0;

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
  }

  readFrame(): Buffer | null {
    const frameLength = this.nextFrameLength();
    if (frameLength === null) {
      return null;
    }
    return this.take(frameLength);
  }

  readMessage(): JSONRPCMessage | null {
    const frame = this.readFrame();
    if (frame === null) {
      return null;
    }
    return deserializeJsonRpcFrame(frame);
  }

  clear(): void {
    this.chunks = [];
    this.headOffset = 0;
    this.bufferedBytes = 0;
  }

  private nextFrameLength(): number | null {
    let scanned = 0;
    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      const start = index === 0 ? this.headOffset : 0;
      const newline = chunk.indexOf(LF, start);
      if (newline >= 0) {
        return scanned + newline - start + 1;
      }
      scanned += chunk.length - start;
    }
    return null;
  }

  private take(byteLength: number): Buffer {
    const first = this.chunks[0];
    const firstAvailable = first.length - this.headOffset;
    if (byteLength <= firstAvailable) {
      const frame = first.subarray(
        this.headOffset,
        this.headOffset + byteLength,
      );
      this.consume(byteLength);
      return frame;
    }

    const frame = Buffer.allocUnsafe(byteLength);
    let copied = 0;
    while (copied < byteLength) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.headOffset;
      const nextCopy = Math.min(byteLength - copied, available);
      chunk.copy(
        frame,
        copied,
        this.headOffset,
        this.headOffset + nextCopy,
      );
      this.consume(nextCopy);
      copied += nextCopy;
    }
    return frame;
  }

  private consume(byteLength: number): void {
    let remaining = byteLength;
    this.bufferedBytes -= byteLength;
    while (remaining > 0 && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const available = chunk.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        return;
      }
      remaining -= available;
      this.chunks.shift();
      this.headOffset = 0;
    }
    if (this.chunks.length === 0) {
      this.headOffset = 0;
    }
  }
}

export function deserializeJsonRpcFrame(frame: Buffer): JSONRPCMessage {
  return JSONRPCMessageSchema.parse(JSON.parse(frameToJsonText(frame)));
}

export function extractJsonRpcFrameMetadata(
  frame: Buffer,
): JsonRpcFrameMetadata | null {
  const end = jsonEnd(frame);
  let index = skipWhitespace(frame, 0, end);
  if (frame[index] !== 0x7b) {
    return null;
  }
  index += 1;

  let id: RequestId | undefined;
  let hasId = false;
  let method: string | undefined;
  let hasResult = false;
  let hasError = false;

  while (index < end) {
    index = skipWhitespace(frame, index, end);
    if (frame[index] === 0x7d) {
      break;
    }
    if (frame[index] === 0x2c) {
      index += 1;
      continue;
    }

    const key = readJsonString(frame, index, end);
    if (!key) {
      return null;
    }
    index = skipWhitespace(frame, key.end, end);
    if (frame[index] !== 0x3a) {
      return null;
    }
    index = skipWhitespace(frame, index + 1, end);

    if (key.value === "id") {
      const idValue = readJsonRpcId(frame, index, end);
      if (idValue) {
        id = idValue.value;
        hasId = true;
        index = idValue.end;
      } else {
        const skipped = skipJsonValue(frame, index, end);
        if (skipped === null) {
          return null;
        }
        index = skipped;
      }
      continue;
    }

    if (key.value === "method") {
      const methodValue = readJsonString(frame, index, end);
      if (methodValue) {
        method = methodValue.value;
        index = methodValue.end;
      } else {
        const skipped = skipJsonValue(frame, index, end);
        if (skipped === null) {
          return null;
        }
        index = skipped;
      }
      continue;
    }

    if (key.value === "result") {
      hasResult = true;
    } else if (key.value === "error") {
      hasError = true;
    }
    const skipped = skipJsonValue(frame, index, end);
    if (skipped === null) {
      return null;
    }
    index = skipped;
  }

  return {
    id,
    hasId,
    method,
    hasResult,
    hasError,
    isRequest: hasId && typeof method === "string",
    isResponse: hasId && (hasResult || hasError),
  };
}

function frameToJsonText(frame: Buffer): string {
  return frame.toString("utf8", 0, jsonEnd(frame));
}

function jsonEnd(frame: Buffer): number {
  let end = frame.length;
  if (end > 0 && frame[end - 1] === LF) {
    end -= 1;
  }
  if (end > 0 && frame[end - 1] === CR) {
    end -= 1;
  }
  return end;
}

function skipWhitespace(frame: Buffer, index: number, end: number): number {
  while (index < end) {
    const byte = frame[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      break;
    }
    index += 1;
  }
  return index;
}

function readJsonString(
  frame: Buffer,
  index: number,
  end: number,
): { value: string; end: number } | null {
  if (frame[index] !== DOUBLE_QUOTE) {
    return null;
  }
  let escaped = false;
  let sawEscape = false;
  const valueStart = index + 1;
  for (let cursor = valueStart; cursor < end; cursor += 1) {
    const byte = frame[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (byte === BACKSLASH) {
      escaped = true;
      sawEscape = true;
      continue;
    }
    if (byte === DOUBLE_QUOTE) {
      const raw = frame.toString("utf8", index, cursor + 1);
      return {
        value: sawEscape ? (JSON.parse(raw) as string) : raw.slice(1, -1),
        end: cursor + 1,
      };
    }
  }
  return null;
}

function readJsonRpcId(
  frame: Buffer,
  index: number,
  end: number,
): { value: RequestId; end: number } | null {
  if (frame[index] === DOUBLE_QUOTE) {
    const value = readJsonString(frame, index, end);
    return value ? { value: value.value, end: value.end } : null;
  }

  const start = index;
  while (index < end) {
    const byte = frame[index];
    if (
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2b ||
      byte === 0x2e ||
      byte === 0x45 ||
      byte === 0x65
    ) {
      index += 1;
      continue;
    }
    break;
  }
  if (index === start) {
    return null;
  }
  const value = Number(frame.toString("utf8", start, index));
  return Number.isFinite(value) ? { value, end: index } : null;
}

function skipJsonValue(
  frame: Buffer,
  index: number,
  end: number,
): number | null {
  index = skipWhitespace(frame, index, end);
  const first = frame[index];
  if (first === DOUBLE_QUOTE) {
    return readJsonString(frame, index, end)?.end ?? null;
  }

  if (first === 0x7b || first === 0x5b) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < end; cursor += 1) {
      const byte = frame[cursor];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (byte === BACKSLASH) {
          escaped = true;
        } else if (byte === DOUBLE_QUOTE) {
          inString = false;
        }
        continue;
      }
      if (byte === DOUBLE_QUOTE) {
        inString = true;
        continue;
      }
      if (byte === 0x7b || byte === 0x5b) {
        depth += 1;
        continue;
      }
      if (byte === 0x7d || byte === 0x5d) {
        depth -= 1;
        if (depth === 0) {
          return cursor + 1;
        }
      }
    }
    return null;
  }

  while (index < end) {
    const byte = frame[index];
    if (byte === 0x2c || byte === 0x7d || byte === 0x5d) {
      break;
    }
    index += 1;
  }
  return index;
}
