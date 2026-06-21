export function shouldAcceptScan(
  identityBefore: string,
  identityAfter: string,
  scanGeneration: number,
  currentGeneration: number
) {
  return identityBefore === identityAfter && scanGeneration === currentGeneration;
}

export function nextScanDelay(attempt: number) {
  return Math.min(300 + attempt * 150, 1200);
}
