// What the connector's parts are built against: the tools (tools/read.ts, drafts.ts,
// irreversible.ts), the context the server builds for each request, and the irreversible action
// kinds (actions/) that both approval channels run. Tools answer data and throw on failure;
// server.ts turns both into MCP results and errors.ts words the failure.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { TFn } from '@/lib/i18n'
import type { McpActionKind, McpClientKind, Settings } from '@/types'
import type { McpScope } from './config'

export type { McpScope }

// The fixed order the irreversible kinds are listed in (Account → Connected apps, the policy editor).
export const ACTION_KINDS: readonly McpActionKind[] = [
  'issue', 'issue_and_send', 'send_email', 'send_reminder', 'storno', 'cancel', 'delete', 'bookamat_sync',
]

export function isActionKind(value: unknown): value is McpActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

// The connection a request came in on, as mcp_authenticate returned it. Never carries a token.
export interface McpGrantInfo {
  id: string
  userId: string
  clientId: string
  clientName: string
  clientKind: McpClientKind
  scopes: readonly McpScope[]
}

// What a service call needs. `supabase` acts as the owner under RLS (the grant's aal2 session in a
// tool, the cookie session on the approval page); never the service role. `t` is always English
// (makeT('en')), on the approval page too: what it words is stored for Claude. Services never read
// cookies for a language.
export interface ServiceContext {
  supabase: SupabaseClient
  // The settings row, read once per request.
  settings(): Promise<Settings>
  t: TFn
  // Epoch ms by which the answer has to be on its way; null where no client is waiting on a timer
  // (an action approved and run in Mado).
  deadline: number | null
}

export interface ToolContext extends ServiceContext {
  grant: McpGrantInfo
  deadline: number
}

// All four hints are stated for every tool (claude.ai prompts for destructive tools).
export interface ToolHints {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

// A tool's answer: one line for the owner, the data for the model. The server sends the summary
// with compact JSON of `data` as text and `data` as structuredContent, capped at MAX_RESULT_CHARS
// (lists page with offset/next_offset).
export interface ToolResult {
  summary: string
  data: Record<string, unknown>
}

// The input schema is a plain z.object (no top-level refine/transform/pipe: the SDK would list it
// without properties). Arguments arrive parsed by it. A failure is thrown: McpToolError, a lifecycle
// or database error, IssueCheckError, EInvoiceError, BookamatError (see errors.ts).
export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  // Registered only for grants that hold it.
  scope: McpScope
  inputSchema: S
  hints: ToolHints
  // E.g. { 'anthropic/requiresUserInteraction': true } on confirm_action.
  meta?: Record<string, unknown>
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>
}

export type AnyToolDef = ToolDef<z.ZodObject>

// Keeps the schema's own argument type inside `run` while the registries hold mixed tools.
export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): AnyToolDef {
  return def as unknown as AnyToolDef
}

// ─── Irreversible actions ────────────────────────────────────────────────────

// What prepare() found, before anything changes: the server stores it in mcp_actions with the
// arguments. `label` and `preview` are the server's own words, shown verbatim to the owner.
export interface ActionPreparation {
  label: string
  preview: Record<string, unknown>
  warnings: string[]
  // Approve in Mado whatever the policy says: a recipient not on the client record, or an action
  // that may outlast the client's deadline.
  forceApp: boolean
  // sha256 of the canonical state the action depends on; compared again before it runs.
  fingerprint: string
}

// What execute() did, stored in mcp_actions.result and read by Claude (confirm_action,
// get_action_status). `summary` is English for the model; the approval page words its own result
// in the owner's language from `data`. A step that fails after an irreversible one succeeded does
// not fail the action: issue_and_send that issued but could not send returns normally (status
// 'done') with the number in data and the send error in data.email_error and `warnings`.
export interface ActionOutcome {
  summary: string
  data: Record<string, unknown>
  warnings?: string[]
}

// One kind of irreversible action. prepare() reads and checks only (blocking problems throw and
// nothing is created); execute() runs after the owner approved, in Mado (cookie client, no
// deadline) or in Claude's prompt (the grant's client, the tool deadline), always behind a fresh
// fingerprint() that matches the stored one.
export interface ActionKind<A extends Record<string, unknown> = Record<string, unknown>> {
  kind: McpActionKind
  // Validates the stored arguments again before they are used.
  argsSchema: z.ZodType<A>
  prepare(ctx: ToolContext, args: A): Promise<ActionPreparation>
  fingerprint(ctx: ServiceContext, args: A): Promise<string>
  execute(ctx: ServiceContext, args: A): Promise<ActionOutcome>
}

export type AnyActionKind = ActionKind<Record<string, unknown>>

export function defineAction<A extends Record<string, unknown>>(def: ActionKind<A>): AnyActionKind {
  return def as unknown as AnyActionKind
}
