import { HTTPError } from "ky";

// Ky throws a generic HTTPError on non-2xx; this extracts our API's
// {error: string} JSON body so callers/UI can show a real message.
export async function toErrorMessage(err: unknown, fallback: string): Promise<string> {
  if (err instanceof HTTPError) {
    try {
      const body = (await err.response.json()) as { error?: string };
      if (body.error) return body.error;
    } catch {
      // response wasn't JSON; fall through to the generic message
    }
  }
  return fallback;
}
