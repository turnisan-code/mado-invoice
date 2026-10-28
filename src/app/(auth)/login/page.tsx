import { safeNextPath } from '@/app/auth/safe-next'
import LoginForm from './LoginForm'

type Query = Record<'next' | 'error', string | string[] | undefined>

export default async function LoginPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams
  const param = (key: keyof Query) => { const value = query[key]; return typeof value === 'string' ? value : null }
  return <LoginForm next={safeNextPath(param('next'))} linkError={param('error') === 'link'} />
}
