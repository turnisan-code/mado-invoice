// Every failure a tool can meet, as a stable code and an English sentence for Claude: the
// connector's own codes, lifecycle refusals (MI0xx), the API codes the routes use, issue problems,
// e-invoice and Bookamat errors. SQL text, stack traces and anything not recognised never reach
// Claude: unknown database failures are 'database', anything else 'internal' (both logged here).
import { ZodError } from 'zod'
import type { DictKey, TFn, TranslateVars } from '@/lib/i18n'
import { knownApiError } from '@/lib/api-errors'
import { BookamatError } from '@/lib/bookamat'
import { bookamatErrorMessage } from '@/lib/bookamat-client'
import { EInvoiceError } from '@/lib/einvoice/common'
import { lifecycleErrorMessage } from '@/lib/status'
import { IssueCheckError, issueProblemMessage } from '@/lib/utils/issue-checks'
import type { IssueProblem } from '@/types'

export type McpErrorCode =
  | 'invalid_input' | 'not_found' | 'draft_only' | 'scope' | 'deadline' | 'state_changed' | 'label_mismatch'
  | 'too_many_pending' | 'rate_limited' | 'result_too_large' | 'client_in_use' | 'internal'

const MCP_ERROR_KEYS: Record<Exclude<McpErrorCode, 'client_in_use'>, DictKey> = {
  invalid_input: 'mcp.errors.invalidInput',
  not_found: 'mcp.errors.notFound',
  draft_only: 'mcp.errors.draftOnly',
  scope: 'mcp.errors.scope',
  deadline: 'mcp.errors.deadline',
  state_changed: 'mcp.errors.stateChanged',
  label_mismatch: 'mcp.errors.labelMismatch',
  too_many_pending: 'mcp.errors.tooManyPending',
  rate_limited: 'mcp.errors.rateLimited',
  result_too_large: 'mcp.errors.resultTooLarge',
  internal: 'messages.api.server_error',
}

export interface ToolError {
  code: string
  message: string
  details?: Record<string, unknown>
}

// Thrown by tools and services for the connector's own refusals. Without a message the code is
// worded from the dictionary (mcp.errors.*), with `vars` filled in.
export class McpToolError extends Error {
  readonly code: McpErrorCode
  readonly vars?: TranslateVars
  readonly details?: Record<string, unknown>

  constructor(code: McpErrorCode, options: { message?: string; vars?: TranslateVars; details?: Record<string, unknown> } = {}) {
    super(options.message ?? '')
    this.name = 'McpToolError'
    this.code = code
    this.vars = options.vars
    this.details = options.details
  }
}

function mcpErrorText(code: McpErrorCode, t: TFn, vars?: TranslateVars, details?: Record<string, unknown>): string {
  if (code === 'client_in_use') return t(details?.in_use === 'projects' ? 'views.clientDelete.hasProjects' : 'clients.form.hasDocuments')
  return t(MCP_ERROR_KEYS[code], vars)
}

const MCP_CODES = new Set<string>([...Object.keys(MCP_ERROR_KEYS), 'client_in_use'])
const LIFECYCLE_CODE = /^MI0\d\d$/
// Raised as plain exceptions by 20261105_mcp.sql, told apart by their message.
const SQL_MESSAGES = new Set<string>(['rate_limited', 'too_many_pending'])

type CodedError = { code?: unknown; message?: unknown; details?: unknown; hint?: unknown; problems?: unknown }

function isProblemList(value: unknown): value is IssueProblem[] {
  return Array.isArray(value) && value.length > 0 && value.every(p => !!p && typeof p === 'object' && typeof (p as { code?: unknown }).code === 'string')
}

function problemsError(problems: IssueProblem[], t: TFn): ToolError {
  return { code: 'incomplete', message: problems.map(p => issueProblemMessage(p, t)).join(' '), details: { problems } }
}

function zodIssues(err: ZodError): string {
  return err.issues.map(i => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`).join('; ')
}

// A database, RPC or route-style error ({ code, message, details }).
function codedError(e: CodedError, t: TFn): ToolError {
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : ''
  const details = typeof e.details === 'string' ? e.details : null

  if (MCP_CODES.has(code)) return { code, message: mcpErrorText(code as McpErrorCode, t) }
  if (LIFECYCLE_CODE.test(code)) {
    switch (code) {
      case 'MI030': return { code, message: t('mcp.errors.notFound') }
      case 'MI031': return { code, message: t('projects.invoice.nothing') }
      case 'MI032': return { code, message: t('projects.invoice.changed') }
      case 'MI033': return { code, message: t('projects.form.deleteBilled') }
      default: return { code, message: lifecycleErrorMessage({ code, message, details }, t), ...(details ? { details: { detail: details } } : {}) }
    }
  }
  if (SQL_MESSAGES.has(message)) return { code: message, message: mcpErrorText(message as McpErrorCode, t) }
  if (code === 'PGRST116') return { code: 'not_found', message: t('mcp.errors.notFound') }
  if (code === 'not_found') return { code, message: t('mcp.errors.notFound') }
  const known = knownApiError(t, { code, error: message, details: e.details })
  if (known) return { code, message: known }
  console.error('[mcp] database error:', code, message)
  return { code: 'database', message: t('messages.api.database') }
}

export function toToolError(err: unknown, t: TFn): ToolError {
  if (err instanceof McpToolError) {
    return {
      code: err.code,
      message: err.message || mcpErrorText(err.code, t, err.vars, err.details),
      ...(err.details ? { details: err.details } : {}),
    }
  }
  if (err instanceof IssueCheckError) return problemsError(err.problems, t)
  if (err instanceof EInvoiceError) return { code: `einvoice_${err.code}`, message: t(`einvoice.errors.${err.code}`) }
  if (err instanceof BookamatError) {
    return { code: `bookamat_${err.code}`, message: bookamatErrorMessage(t, { code: err.code, error: err.message, detail: err.detail }) }
  }
  if (err instanceof ZodError) return { code: 'invalid_input', message: t('mcp.errors.invalidInput', { issues: zodIssues(err) }) }
  if (err && typeof err === 'object') {
    const e = err as CodedError
    if (isProblemList(e.problems)) return problemsError(e.problems, t)
    if (typeof e.code === 'string' && e.code) return codedError(e, t)
    // DocumentNotFoundError (src/lib/pdf/render.ts), told apart without importing the PDF renderer.
    if (err instanceof Error && err.message === 'Document not found') return { code: 'not_found', message: t('mcp.errors.notFound') }
  }
  console.error('[mcp] tool failed:', err)
  return { code: 'internal', message: t('messages.api.server_error') }
}
