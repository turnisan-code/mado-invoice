// Force light mode for the client-facing portal — no dark theme.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="light" style={{ colorScheme: 'light', background: '#f5f5f5', color: '#171717', minHeight: '100vh' }}>
      {children}
    </div>
  )
}
