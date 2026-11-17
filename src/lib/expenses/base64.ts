// Gmail returns attachment data base64url-encoded ('-' and '_' instead of '+' and
// '/', no padding). Anthropic's document blocks expect standard base64 and refused
// every Gmail receipt with „Invalid base64 data“, so no receipt was ever read.
// Convert once, where the data leaves Gmail; standard input passes through unchanged.
export function toStandardBase64(data: string): string {
  return Buffer.from(data, 'base64url').toString('base64')
}
