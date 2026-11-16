// What a Beleg is, from its first bytes, and the name it is stored under in bookamat.
// bookamat keeps PDF, JPG, PNG and GIF. A name can be wrong (every attachment used to
// be named „….pdf“, a phone photo too), and a HEIC photo is none of the four, so the
// bytes decide; the name's extension only when the bytes don't say.

export type AttachmentType = 'pdf' | 'jpg' | 'png' | 'gif'

const ALLOWED: AttachmentType[] = ['pdf', 'jpg', 'png', 'gif']

export function sniffAttachmentType(bytes: Uint8Array): AttachmentType | null {
  const at = (i: number, ...b: number[]) => b.every((x, k) => bytes[i + k] === x)
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  // „%PDF“ may follow a few bytes of junk (allowed within the first 1024)
  for (let i = 0; i + 3 < Math.min(bytes.length, 1024); i++) {
    if (at(i, 0x25, 0x50, 0x44, 0x46)) return 'pdf'
  }
  return null
}

function extensionOf(name: string | null | undefined): AttachmentType | null {
  const m = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : ''
  return (ALLOWED as string[]).includes(ext) ? (ext as AttachmentType) : null
}

// The name to attach `bytes` under: `base` plus the real extension, or an error that
// says why bookamat cannot keep the file.
export function attachmentName(
  bytes: Uint8Array,
  base: string,
  originalName?: string | null,
): { name: string; error?: undefined } | { name?: undefined; error: string } {
  const type = sniffAttachmentType(bytes) ?? extensionOf(originalName)
  if (!type) {
    const ext = (originalName || '').match(/\.([A-Za-z0-9]+)$/)?.[1]?.toUpperCase()
    return { error: `${ext ? `${ext}-Datei` : 'Datei'} kann bookamat nicht speichern (nur PDF, JPG, PNG, GIF)` }
  }
  return { name: `${base}.${type}` }
}
