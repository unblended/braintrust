export function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function logWarn(event: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ event, ...fields }));
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const errorMessage = getErrorMessage(error);
  console.error(JSON.stringify({ event, error: errorMessage, ...fields }));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
