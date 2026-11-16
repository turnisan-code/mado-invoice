import './owner'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { counterpartyVatin, isOwnVatin, OWN_VATIN } from '../vatin'

// The owner's own UID (AUDIT.md's published figure, as the existing fixtures use it)
const OWN = 'ATU12345675'

describe('isOwnVatin — the owner’s own UID, however it is written', () => {
  test('the default is the owner’s UID', () => {
    assert.equal(OWN_VATIN, OWN)
  })
  test('spaces, dots, hyphens and case do not matter', () => {
    for (const v of [OWN, 'ATU 123 456 75', 'atu12345675', 'ATU-123.456.75', ` ${OWN} `]) assert.equal(isOwnVatin(v), true, v)
  })
  test('another UID, a bare prefix, nothing: not his', () => {
    for (const v of ['ATU73569248', 'ATU', 'ATU1234567', 'DE12345675', '', null, undefined]) assert.equal(isOwnVatin(v), false, String(v))
  })
  test('counterpartyVatin never keeps it', () => {
    assert.equal(counterpartyVatin('ATU 123 456 75'), '')
    assert.equal(counterpartyVatin('ATU73569248'), 'ATU73569248')
  })
})
