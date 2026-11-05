import { roundCents } from '@/lib/utils/number'

// A small deterministic XML writer: elements and attributes come out in the order given, with
// two-space indentation. Optional values that are null or blank are left out together with their
// element (Peppol forbids empty elements), so callers can pass optional data straight through.

type AttrValue = string | number | null | undefined
export type Attrs = Record<string, AttrValue>

export interface XmlElement {
  name: string
  attrs: Attrs
  text: string | null
  children: XmlElement[]
}

export type XmlChild = XmlElement | null | undefined | false | XmlChild[]

// XML 1.0 has no representation for most control characters; a pasted one would make the file unreadable.
const INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

export function escapeXml(value: string): string {
  return value
    .replace(INVALID_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function flatten(children: XmlChild[]): XmlElement[] {
  const out: XmlElement[] = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child))
    else if (child) out.push(child)
  }
  return out
}

// A container element; null when none of its children is present.
export function el(name: string, attrs: Attrs | null, ...children: XmlChild[]): XmlElement | null {
  const kids = flatten(children)
  return kids.length ? { name, attrs: attrs ?? {}, text: null, children: kids } : null
}

// A text element; null when the value is missing or blank.
export function txt(name: string, value: string | number | null | undefined, attrs?: Attrs): XmlElement | null {
  if (value == null) return null
  const text = String(value).replace(/\r\n?/g, '\n')
  return text.trim() ? { name, attrs: attrs ?? {}, text, children: [] } : null
}

// A text element the schema requires even when the value is empty.
export function req(name: string, value: string | number | null | undefined, attrs?: Attrs): XmlElement {
  return { name, attrs: attrs ?? {}, text: value == null ? '' : String(value).replace(/\r\n?/g, '\n'), children: [] }
}

function write(node: XmlElement, depth: number, out: string[]) {
  const pad = '  '.repeat(depth)
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('')
  if (node.text != null) {
    out.push(`${pad}<${node.name}${attrs}>${escapeXml(node.text)}</${node.name}>`)
    return
  }
  out.push(`${pad}<${node.name}${attrs}>`)
  for (const child of node.children) write(child, depth + 1, out)
  out.push(`${pad}</${node.name}>`)
}

export function serializeXml(root: XmlElement | null): string {
  if (!root) throw new Error('Empty XML document')
  const out = ['<?xml version="1.0" encoding="UTF-8"?>']
  write(root, 0, out)
  return out.join('\n') + '\n'
}

// Amounts with exactly two decimals and never "-0.00".
export function amount(value: number): string {
  return roundCents(value).toFixed(2)
}

// Quantities, prices and rates with up to `digits` decimals and no trailing zeros.
export function decimal(value: number, digits = 4): string {
  const fixed = value.toFixed(digits)
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return trimmed === '-0' ? '0' : trimmed
}
