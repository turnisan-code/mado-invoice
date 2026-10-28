// One rule for every place that names a client: the company when there is one, else the
// contact name. A client has either or both, never neither.
export interface NamedClient {
  name: string | null
  company: string | null
}

export function clientDisplayName(c: NamedClient | null | undefined): string {
  return c?.company || c?.name || ''
}

// "Acme GmbH (Jane Doe)" when both exist, for pickers where the contact disambiguates.
export function clientLabel(c: NamedClient | null | undefined): string {
  if (c?.company && c.name) return `${c.company} (${c.name})`
  return clientDisplayName(c)
}
