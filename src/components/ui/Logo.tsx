export default function Logo({ className = '' }: { className?: string }) {
  return (
    <svg width="148" height="28" viewBox="0 0 148 28" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* M letterform */}
      <path d="M4 22V6L14 16L24 6V22" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Waveform bars */}
      <rect x="30" y="9" width="3" height="10" rx="1.5" fill="currentColor"/>
      <rect x="36" y="4" width="3" height="20" rx="1.5" fill="currentColor"/>
      <rect x="42" y="12" width="3" height="4" rx="1.5" fill="currentColor"/>
      {/* MADO bold */}
      <text x="54" y="20" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fontSize="13" fontWeight="700" fill="currentColor" letterSpacing="0.04em">MADO</text>
      {/* INVOICE light */}
      <text x="96" y="20" fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fontSize="13" fontWeight="300" fill="currentColor" opacity="0.45" letterSpacing="0.04em">INVOICE</text>
    </svg>
  )
}
