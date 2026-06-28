import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../db/schema'
import type { ContactsSyncResult } from '../contacts/sync-contacts'
import { startContactsSync, type ContactsSyncController, type ContactsSyncStatus } from './contacts-sync'

vi.mock('../contacts/sync-contacts', () => ({
  syncLocalContacts: vi.fn(),
}))

// Imported after the mock declaration so we get the mocked implementation.
import { syncLocalContacts } from '../contacts/sync-contacts'

const mockedSyncLocalContacts = vi.mocked(syncLocalContacts)

// The controller only ever passes db straight through to syncLocalContacts, which is
// mocked, so a bare cast is sufficient for these tests.
const fakeDb = {} as AppDatabase

let controller: ContactsSyncController | null = null

afterEach(() => {
  controller?.stop()
  controller = null
  vi.clearAllMocks()
})

// A very large poll interval means the timer scheduled on construction never fires
// during a test, so we can exercise the explicit syncNow()/stop() surface in isolation.
const NEVER_POLL = 1e9

describe('startContactsSync', () => {
  it('reports syncing then idle with the resolved counts on success', async () => {
    const result: ContactsSyncResult = { scannedContacts: 7, resolvedHandles: 12 }
    mockedSyncLocalContacts.mockReturnValue(result)

    const statuses: ContactsSyncStatus[] = []
    controller = startContactsSync(fakeDb, {
      pollIntervalMs: NEVER_POLL,
      onStatus: (status) => statuses.push(status),
    })

    const final = await controller.syncNow()

    expect(final).toEqual({ state: 'idle', scannedContacts: 7, resolvedHandles: 12 })
    // The explicit syncNow() emits syncing then idle.
    expect(statuses).toContainEqual({ state: 'syncing', scannedContacts: 0, resolvedHandles: 0 })
    expect(statuses).toContainEqual({ state: 'idle', scannedContacts: 7, resolvedHandles: 12 })
  })

  it('reports an error status carrying the thrown message', async () => {
    mockedSyncLocalContacts.mockImplementation(() => {
      throw new Error('contacts unavailable')
    })

    controller = startContactsSync(fakeDb, { pollIntervalMs: NEVER_POLL })

    const final = await controller.syncNow()

    expect(final).toEqual({
      state: 'error',
      scannedContacts: 0,
      resolvedHandles: 0,
      error: 'contacts unavailable',
    })
  })

  it('coalesces concurrent syncNow() calls into a single underlying run', async () => {
    mockedSyncLocalContacts.mockReturnValue({ scannedContacts: 1, resolvedHandles: 1 })

    controller = startContactsSync(fakeDb, { pollIntervalMs: NEVER_POLL })

    // The construction-time run plus two explicit calls issued before it settles must
    // all coalesce onto the single in-flight `running` promise, so syncLocalContacts
    // runs exactly once. (syncNow is async, so each call returns a distinct promise
    // wrapper even when it hits the `if (running) return running` short-circuit, which
    // is why we assert on the call count rather than promise identity.)
    const first = controller.syncNow()
    const second = controller.syncNow()

    await Promise.all([first, second])

    expect(mockedSyncLocalContacts).toHaveBeenCalledTimes(1)
  })

  it('emits a stopped status when stop() is called', async () => {
    mockedSyncLocalContacts.mockReturnValue({ scannedContacts: 0, resolvedHandles: 0 })

    const statuses: ContactsSyncStatus[] = []
    controller = startContactsSync(fakeDb, {
      pollIntervalMs: NEVER_POLL,
      onStatus: (status) => statuses.push(status),
    })
    await controller.syncNow()

    controller.stop()
    controller = null

    expect(statuses).toContainEqual({ state: 'stopped', scannedContacts: 0, resolvedHandles: 0 })
  })
})
