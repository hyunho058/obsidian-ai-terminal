/** Something that can report when it is listening (bridge server, IDE connection). */
export interface Listenable {
  whenListening(): Promise<void>;
}

/** True if `target` is (or becomes) listening within `ms`; false if it is disabled, failed or too slow. */
export async function listensWithin(target: Listenable, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([target.whenListening().then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
