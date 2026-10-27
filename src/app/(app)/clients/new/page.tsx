import ClientForm from '@/components/forms/ClientForm'
import { getT } from '@/lib/i18n/server'

export default async function NewClientPage() {
  const { t } = await getT()
  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">{t('clients.new')}</h1>
      <ClientForm />
    </div>
  )
}
