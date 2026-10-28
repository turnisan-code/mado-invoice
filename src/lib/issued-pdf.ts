// Browser helpers for the frozen PDF of a numbered document: every outgoing copy (download,
// email, Drive, Bookamat, reminders) is the stored one, never a fresh render of the editor.

export async function fetchIssuedPdf(documentId: string): Promise<Blob> {
  const res = await fetch(`/api/documents/${documentId}/pdf`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(typeof data.error === 'string' && data.error ? data.error : res.statusText)
  }
  return res.blob()
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(new Error('Failed to read PDF'))
    reader.readAsDataURL(blob)
  })
}
