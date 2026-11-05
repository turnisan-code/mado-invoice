// The irreversible action kinds both approval channels run (confirm_action in Claude, the
// approval page in Mado). A kind without an entry cannot be prepared.
import type { McpActionKind } from '@/types'
import type { AnyActionKind } from '../types'
import { bookamatSyncAction } from './bookamat-sync'
import { cancelAction } from './cancel'
import { deleteAction } from './delete'
import { issueAction } from './issue'
import { issueAndSendAction } from './issue-and-send'
import { sendEmailAction } from './send-email'
import { sendReminderAction } from './send-reminder'
import { stornoAction } from './storno'

export const ACTIONS: Partial<Record<McpActionKind, AnyActionKind>> = {
  issue: issueAction,
  issue_and_send: issueAndSendAction,
  send_email: sendEmailAction,
  send_reminder: sendReminderAction,
  storno: stornoAction,
  cancel: cancelAction,
  delete: deleteAction,
  bookamat_sync: bookamatSyncAction,
}

export function actionKind(kind: string): AnyActionKind | null {
  return Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind as McpActionKind] ?? null : null
}
