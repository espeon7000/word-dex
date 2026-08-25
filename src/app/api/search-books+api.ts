import { requireAuth } from "@/server/jwt";
import { captureException } from "@/server/sentry";

// components/book-prompt.tsx's searchBooksOnce, moved server-side - same
// reasoning as verify-sentence+api.ts/classify-mood+api.ts (the client used
// to call googleapis.com directly with EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY
// inlined into the bundle). Mirrors that function's own response/error
// shape exactly (status + Google's own error reason on failure) so the
// client-side retry-on-5xx logic in searchBooks() keeps working unchanged.
export async function GET(request: Request) {
  try {
    await requireAuth(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    const offset = url.searchParams.get("offset") ?? "0";
    const maxResults = url.searchParams.get("maxResults") ?? "4";
    if (!query) {
      return Response.json({ error: "q is required" }, { status: 400 });
    }

    const key = process.env.GOOGLE_BOOKS_API_KEY;
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&startIndex=${offset}&maxResults=${maxResults}${key ? `&key=${key}` : ""}`,
    );
    if (!res.ok) {
      // Raw reason only, no "search failed: ..." formatting - the client
      // (searchBooksOnce) builds that same string itself, same as it did
      // when it parsed Google's error shape directly.
      const body = await res.json().catch(() => null);
      const reason = body?.error?.message ?? res.statusText;
      return Response.json({ error: reason }, { status: res.status });
    }
    const data = await res.json();
    return Response.json(data);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[search-books] error", error);
    await captureException(error, "search-books");
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
