export const DEFAULT_SUMMARY_DATA_URL = 'https://shoppingdeals.au/mbs/mbs_data.json';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache keyed by URL so different test URLs don't collide.
const feedCache = new Map();

export async function fetchSummaryFeed(options = {}) {
  const url = options.summaryDataUrl ?? process.env.MBS_SUMMARY_DATA_URL ?? DEFAULT_SUMMARY_DATA_URL;
  const ttlMs =
    options.summaryCacheTtlMs ??
    Number.parseInt(process.env.MBS_SUMMARY_CACHE_TTL_MS ?? String(DEFAULT_CACHE_TTL_MS), 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    options.timeoutMs ?? Number.parseInt(process.env.MBS_API_TIMEOUT_MS ?? '15000', 10);

  const now = Date.now();
  const cached = feedCache.get(url);

  if (cached && ttlMs > 0 && now - cached.timestamp < ttlMs) {
    return cached.data;
  }

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Summary feed request failed with status ${response.status}.`);
  }

  const data = await response.json();
  feedCache.set(url, { data, timestamp: now });
  return data;
}

export async function lookupSummaryItem(itemNumber, options = {}) {
  const feed = await fetchSummaryFeed(options);
  const entry = feed[String(itemNumber)];

  if (!entry) {
    return null;
  }

  return {
    summary: entry.content ?? null,
    summaryUpdated: entry.updated ?? null
  };
}
