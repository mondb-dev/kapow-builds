/**
 * Google Custom Search API tool.
 *
 * Requires:
 *   GOOGLE_SEARCH_API_KEY  — Google API key with Custom Search API enabled
 *   GOOGLE_SEARCH_ENGINE_ID — Programmable Search Engine ID (cx parameter)
 *
 * Returns up to 10 results with title, url, and snippet.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function googleSearch(
  query: string,
  numResults: number = 10,
): Promise<string> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!apiKey || !cx) {
    return (
      'Google Search is not configured. ' +
      'Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID in the environment. ' +
      'See: https://developers.google.com/custom-search/v1/introduction'
    );
  }

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(numResults, 10)));

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Search API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json() as {
    items?: { title: string; link: string; snippet: string }[];
    searchInformation?: { totalResults: string };
    error?: { message: string };
  };

  if (data.error) throw new Error(`Google Search API: ${data.error.message}`);

  const items = data.items ?? [];
  if (items.length === 0) return `No results found for: ${query}`;

  const total = data.searchInformation?.totalResults ?? '?';
  const lines = [
    `Search: "${query}" — ${total} total results, showing ${items.length}`,
    '',
    ...items.map((item, i) =>
      `${i + 1}. ${item.title}\n   URL: ${item.link}\n   ${item.snippet}`
    ),
  ];

  return lines.join('\n');
}
