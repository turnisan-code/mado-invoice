import { ImageResponse } from 'next/og'

export const contentType = 'image/png'

// Served at /icon/<id>; the manifest references the 192/512 variants by these paths.
const VARIANTS: Record<string, { px: number; maskable: boolean }> = {
  '32': { px: 32, maskable: false },
  '192': { px: 192, maskable: false },
  '512': { px: 512, maskable: false },
  '512-maskable': { px: 512, maskable: true },
}

export function generateImageMetadata() {
  return Object.entries(VARIANTS).map(([id, { px }]) => ({
    id,
    size: { width: px, height: px },
    contentType,
  }))
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const variant = VARIANTS[String(await id)] ?? VARIANTS['32']
  const { px, maskable } = variant
  // Maskable icons are cropped to a circle by the launcher, so the artwork stays inside the inner 60 %.
  const scale = (px / 180) * (maskable ? 0.62 : 0.9)
  const small = px <= 48

  return new ImageResponse(
    <div
      style={{
        background: '#0a0a0a',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: maskable ? 0 : small ? px * 0.19 : px * 0.22,
      }}
    >
      <div style={{ color: 'white', fontSize: small ? px * 0.62 : 96 * scale, fontWeight: small ? 700 : 800, fontFamily: 'system-ui', lineHeight: 1 }}>M</div>
      {!small && (
        <div style={{ display: 'flex', gap: 5 * scale, alignItems: 'center', marginTop: 6 * scale }}>
          <div style={{ width: 8 * scale, height: 14 * scale, background: 'white', borderRadius: 4 * scale, opacity: 0.7 }} />
          <div style={{ width: 8 * scale, height: 22 * scale, background: 'white', borderRadius: 4 * scale }} />
          <div style={{ width: 8 * scale, height: 8 * scale, background: 'white', borderRadius: 4 * scale, opacity: 0.7 }} />
        </div>
      )}
    </div>,
    { width: px, height: px },
  )
}
