/** Purpose: run async work over a list with bounded concurrency and stable ordering. */
export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  limit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const maxConcurrency = Math.max(1, Math.trunc(limit));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) continue;
      results[index] = await worker(items[index], index);
    }
  };

  const runners = Array.from({ length: Math.min(maxConcurrency, items.length) }, () => runWorker());
  await Promise.all(runners);
  return results;
}
