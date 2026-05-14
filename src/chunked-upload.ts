/**
 * Creates a WritableStream that uploads data as sequential POST requests.
 * Used as a fallback for browsers that don't support fetch() with ReadableStream body (e.g., Safari).
 *
 * Data chunks are sent to: ${baseUrl}/0, ${baseUrl}/1, ${baseUrl}/2, ...
 * When close() is called, a final empty POST signals end-of-stream to the server.
 *
 * Server-side command (bash):
 *   i=0; while true; do
 *     tmp=$(mktemp); curl -sSN "${CS_URL}/$i" > "$tmp"
 *     [ ! -s "$tmp" ] && { rm "$tmp"; break; }
 *     cat "$tmp"; rm "$tmp"; i=$((i+1))
 *   done | nc localhost $PORT | curl -sSNT - "$SC_URL"
 */
export function createChunkedUploadWritable(
  baseUrl: string,
  headers: Headers,
): WritableStream<Uint8Array> {
  let chunkIndex = 0;
  let buffer: Uint8Array[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Sequential chain ensures chunks are sent in order
  let flushPromise: Promise<void> = Promise.resolve();

  function mergeBuffers(buffers: Uint8Array[]): Uint8Array {
    const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const b of buffers) {
      merged.set(b, offset);
      offset += b.byteLength;
    }
    return merged;
  }

  async function sendChunk(data: Uint8Array): Promise<void> {
    await fetch(`${baseUrl}/${chunkIndex++}`, {
      method: 'POST',
      headers,
      body: data,
    });
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const chunks = buffer.splice(0);
    await sendChunk(mergeBuffers(chunks));
  }

  function scheduleFlush(): void {
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPromise = flushPromise.then(flush);
      }, 20); // 20ms batching window for keystrokes
    }
  }

  return new WritableStream<Uint8Array>({
    write(chunk) {
      buffer.push(chunk);
      scheduleFlush();
    },
    async close() {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // Wait for any in-flight flushes, then flush remaining data
      await flushPromise;
      await flush();
      // Send empty chunk to signal end-of-stream to the server-side loop
      await sendChunk(new Uint8Array(0));
    },
    abort(_reason) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
  });
}
