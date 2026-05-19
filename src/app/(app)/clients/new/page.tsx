import ClientForm from '@/components/forms/ClientForm'

export default function NewClientPage() {
  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">New Client</h1>
      <ClientForm />
    </div>
  )
}
