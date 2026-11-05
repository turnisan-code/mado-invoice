export default function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400 empty:hidden">
      {message}
    </p>
  )
}
