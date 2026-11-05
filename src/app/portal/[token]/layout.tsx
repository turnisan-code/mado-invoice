import { sharedDocumentLanguage } from './language'
import { PortalLanguageProvider } from './PortalLanguage'

// Gives the not-found and error pages of a shared document its language.
export default async function SharedDocumentLayout({ children, params }: { children: React.ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params
  const lang = await sharedDocumentLanguage(token)
  return <PortalLanguageProvider lang={lang}>{children}</PortalLanguageProvider>
}
