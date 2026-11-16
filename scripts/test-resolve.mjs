// Module resolution for `npm test` (node --test, no dependencies): '@/…' is src/…, and an
// import without an extension finds its .ts/.tsx file or index, as Next's bundler does.
// 'server-only' is a no-op here: tests run on the server side anyway.
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'src')
const SUFFIXES = ['.ts', '.tsx', '.mts', '.js', '/index.ts', '/index.tsx']

function findFile(base) {
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const suffix of SUFFIXES) if (existsSync(base + suffix)) return base + suffix
  return null
}

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true }
  let base = null
  if (specifier.startsWith('@/')) base = path.join(SRC, specifier.slice(2))
  else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith('file:')) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
  }
  const file = base && findFile(base)
  if (file) return { url: pathToFileURL(file).href, shortCircuit: true }
  return next(specifier, context)
}
