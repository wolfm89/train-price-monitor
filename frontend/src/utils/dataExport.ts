/**
 * Adds the sign-in attributes Cognito holds (the backend export only covers
 * the app's own database) to the downloaded data export.
 */
export function withLoginAttributes(exportJson: string, loginAttributes: Record<string, string> | null): string {
  const document = JSON.parse(exportJson) as Record<string, unknown>;
  return JSON.stringify({ ...document, login: loginAttributes ?? null }, null, 2);
}

export function exportFileName(now: Date = new Date()): string {
  return `train-price-monitor-data-${now.toISOString().slice(0, 10)}.json`;
}

/** Saves text as a file through a temporary object URL; nothing leaves the browser. */
export function downloadTextFile(content: string, fileName: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
