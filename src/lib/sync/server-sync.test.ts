import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../db/schema'
import { createServerSyncEngine } from './server-sync'

const messageSyncMocks = vi.hoisted(() => ({
  startIMessageSync: vi.fn(),
  syncNow: vi.fn(),
  getStatus: vi.fn(),
  stop: vi.fn(),
}))

const contactsSyncMocks = vi.hoisted(() => ({
  startContactsSync: vi.fn(),
  syncNow: vi.fn(),
  getStatus: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('./imessage-sync', () => ({
  startIMessageSync: messageSyncMocks.startIMessageSync,
}))

vi.mock('./contacts-sync', () => ({
  startContactsSync: contactsSyncMocks.startContactsSync,
}))

const fakeDb = {} as AppDatabase

beforeEach(() => {
  vi.clearAllMocks()
  messageSyncMocks.startIMessageSync.mockReturnValue({
    syncNow: messageSyncMocks.syncNow,
    getStatus: messageSyncMocks.getStatus,
    stop: messageSyncMocks.stop,
  })
  contactsSyncMocks.startContactsSync.mockReturnValue({
    syncNow: contactsSyncMocks.syncNow,
    getStatus: contactsSyncMocks.getStatus,
    stop: contactsSyncMocks.stop,
  })
  messageSyncMocks.getStatus.mockReturnValue({
    state: 'idle',
    cursor: 42,
    importedMessages: 5,
    hasMore: false,
  })
  contactsSyncMocks.getStatus.mockReturnValue({
    state: 'idle',
    scannedContacts: 3,
    resolvedHandles: 7,
  })
})

describe('createServerSyncEngine', () => {
  it('returns the combined active sync status from the existing controllers', () => {
    const engine = createServerSyncEngine(fakeDb)

    expect(engine.getStatus()).toEqual({
      messages: {
        state: 'idle',
        cursor: 42,
        importedMessages: 5,
        hasMore: false,
      },
      contacts: {
        state: 'idle',
        scannedContacts: 3,
        resolvedHandles: 7,
      },
    })
  })

  it('drives Messages catch-up mode and returns the refreshed status', async () => {
    const engine = createServerSyncEngine(fakeDb)

    await expect(engine.syncMessages()).resolves.toEqual(engine.getStatus())

    expect(messageSyncMocks.syncNow).toHaveBeenCalledWith({ catchUp: true })
    expect(contactsSyncMocks.syncNow).not.toHaveBeenCalled()
  })

  it('drives the Contacts owner for contact sync requests', async () => {
    const engine = createServerSyncEngine(fakeDb)

    await engine.syncContacts()

    expect(contactsSyncMocks.syncNow).toHaveBeenCalledWith()
    expect(messageSyncMocks.syncNow).not.toHaveBeenCalled()
  })
})
