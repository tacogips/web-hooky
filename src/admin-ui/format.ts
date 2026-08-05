/**
 * Small formatting helpers shared by the admin UI views.
 */

/** Extracts a displayable message from an unknown rejection value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unexpected error";
}

/** Renders a unix timestamp as a local date-time string. */
export function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}
