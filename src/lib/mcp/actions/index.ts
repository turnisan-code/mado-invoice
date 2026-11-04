// The irreversible action kinds both approval channels run (confirm_action in Claude, the
// approval page in Mado). A kind without an entry cannot be prepared.
import type { McpActionKind } from '@/types'
import type { AnyActionKind } from '../types'

export const ACTIONS: Partial<Record<McpActionKind, AnyActionKind>> = {}

export function actionKind(kind: string): AnyActionKind | null {
  return Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind as McpActionKind] ?? null : null
}
