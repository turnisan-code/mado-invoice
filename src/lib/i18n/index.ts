import { en, type Dict } from './en'
import { de } from './de'

export type { Dict }
export type UiLang = 'de' | 'en'
export const UI_LANGS: readonly UiLang[] = ['de', 'en']

// Every dotted path to a string in the dictionary, so a typo in a t() key is a type error.
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : T[K] extends object ? Leaves<T[K], `${P}${K}.`> : never
}[keyof T & string]
export type DictKey = Leaves<Dict>

export type TranslateVars = Record<string, string | number>
export type TFn = (key: DictKey, vars?: TranslateVars) => string

export function isUiLang(value: unknown): value is UiLang {
  return value === 'de' || value === 'en'
}

export function getDict(lang: UiLang): Dict {
  return lang === 'de' ? de : en
}

function resolve(dict: Dict, key: string): string | undefined {
  let node: unknown = dict
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

function interpolate(text: string, vars: TranslateVars): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

// Looks a dotted key up in `dict`, then in English; a key unknown to both yields its last
// segment (e.g. a raw status value), so the UI never shows "status.foo".
export function translate(dict: Dict, key: DictKey, vars?: TranslateVars): string {
  let value = resolve(dict, key)
  if (value === undefined) {
    if (process.env.NODE_ENV !== 'production') console.warn(`[i18n] missing key "${key}"`)
    value = resolve(en, key) ?? key.slice(key.lastIndexOf('.') + 1)
  }
  return vars ? interpolate(value, vars) : value
}

export function n(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

export function makeT(lang: UiLang): TFn {
  const dict = getDict(lang)
  return (key, vars) => translate(dict, key, vars)
}
