import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { humanizeBookamatError } from '../bookamat-errors'

const raw = (msg: string) => `bookamat API error 400: {"non_field_errors":["${msg}"]}`

describe('humanizeBookamatError', () => {
  test('explains the missing-UID rejection and keeps the original', () => {
    const out = humanizeBookamatError(raw('Vatin is required because of the selected purchasetax account.'))
    assert.match(out, /UID-Nummer des Lieferanten fehlt/)
    assert.match(out, /Vatin is required/) // ground truth stays attached
  })

  test('covers the error classes this import actually hit', () => {
    assert.match(humanizeBookamatError(raw('Deductibility amount percent is blocked with the selected cost account.')),
      /Abzugsfähigkeit selbst vor/)
    assert.match(humanizeBookamatError(raw('The provided tax percent value is not allowed with the given purchasetax account.')),
      /USt-Satz passt nicht/)
    assert.match(humanizeBookamatError(raw('The provided purchasetax account is not allowed to be used with the given cost account.')),
      /Kombination aus Steuerkonto und Vorsteuerkonto/)
    assert.match(humanizeBookamatError('bookamat API error 400: {"name":["Invalid extension."]}'),
      /Buchung selbst wurde angelegt/)
  })

  test('unknown errors pass through untouched rather than being hidden', () => {
    const weird = 'bookamat API error 500: something nobody has seen before'
    assert.equal(humanizeBookamatError(weird), weird)
  })
})
