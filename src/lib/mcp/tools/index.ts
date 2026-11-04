// Every tool, in the fixed order tools/list shows them: reads, then draft writes, then the
// irreversible ones. Each file belongs to one part of the connector and only that file changes
// when its tools do.
import type { AnyToolDef } from '../types'
import { DRAFT_TOOLS } from './drafts'
import { IRREVERSIBLE_TOOLS } from './irreversible'
import { READ_TOOLS } from './read'

export const TOOLS: readonly AnyToolDef[] = [...READ_TOOLS, ...DRAFT_TOOLS, ...IRREVERSIBLE_TOOLS]

const duplicate = TOOLS.find((tool, i) => TOOLS.findIndex(other => other.name === tool.name) !== i)
if (duplicate) throw new Error(`MCP tool "${duplicate.name}" is defined twice`)

// The tools a grant may see and call; anything outside its scopes is neither listed nor run.
export function toolsForScopes(scopes: readonly string[]): AnyToolDef[] {
  return TOOLS.filter(tool => scopes.includes(tool.scope))
}

export function findTool(name: string): AnyToolDef | undefined {
  return TOOLS.find(tool => tool.name === name)
}
