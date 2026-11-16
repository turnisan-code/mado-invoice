// Loaded with `node --import` before the tests: registers the resolver in test-resolve.mjs.
import { register } from 'node:module'

register('./test-resolve.mjs', import.meta.url)
