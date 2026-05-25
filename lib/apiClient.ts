// Tiny helper that resolves the FastAPI backend URL from NEXT_PUBLIC_API_BASE
// and provides one fetch wrapper everything else funnels through. Keeping it
// in one place means swapping the prod host is a one-line change here, and the
// dev story stays "uvicorn on :8000, next dev on :3000" without any per-call
// guesswork.

export const API_BASE: string =
    process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") || "http://localhost:8000";

/** Resolve a backend path (with or without leading slash) to a full URL. */
export function apiUrl(path: string): string {
    return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Minimal JSON fetch — throws on non-2xx so callers can handle errors uniformly. */
export async function apiJson<T>(
    path: string,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(apiUrl(path), {
        cache: "no-store",
        ...init,
    });
    if (!res.ok) {
        throw new Error(`API ${path} → HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
}
