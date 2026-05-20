import { ImageResponse } from 'next/og'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
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
      }}
    >
      {/* M letterform */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0px' }}>
        <div style={{ color: 'white', fontSize: '96px', fontWeight: '800', fontFamily: 'system-ui', lineHeight: 1 }}>M</div>
      </div>
      {/* Waveform accent — three bars */}
      <div style={{ display: 'flex', gap: '5px', alignItems: 'center', marginTop: '6px' }}>
        <div style={{ width: '8px', height: '14px', background: 'white', borderRadius: '4px', opacity: 0.7 }} />
        <div style={{ width: '8px', height: '22px', background: 'white', borderRadius: '4px' }} />
        <div style={{ width: '8px', height: '8px', background: 'white', borderRadius: '4px', opacity: 0.7 }} />
      </div>
    </div>,
    { ...size },
  )
}
