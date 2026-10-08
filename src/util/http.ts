import type { IncomingMessage } from 'http';

/** Reads a request body; `'too-large'` (and the rest is drained) once it exceeds `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? 'too-large' : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
