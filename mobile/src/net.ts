// fetch with a hard timeout. AbortSignal.timeout() is not reliable on
// Hermes, so we roll our own with AbortController + setTimeout.

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 20000
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      throw new Error(`Request timed out after ${ms}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ms = 20000
): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    ms
  );
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON error body — leave null
  }
  return { ok: res.ok, status: res.status, json };
}
