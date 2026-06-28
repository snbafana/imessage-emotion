import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../db/schema'
import type { IMessageBatch } from '../imessage/types'
import { startIMessageSync } from './imessage-sync'

const readerMocks = vi.hoisted(() => ({
  buildBatch: vi.fn(),
  close: vi.fn(),
  LocalIMessageReader: vi.fn(),
}))

const importMocks = vi.hoisted(() => ({
  getLastImportedRowid: vi.fn(),
  importBatch: vi.fn(),
  recordImportError: vi.fn(),
}))

vi.mock('../imessage/reader', () => ({
  DEFAULT_CHAT_DB_PATH: '/tmp/chat.db',
  LocalIMessageReader: readerMocks.LocalIMessageReader,
}))

vi.mock('../import/import-messages', () => ({
  getLastImportedRowid: importMocks.getLastImportedRowid,
  importBatch: importMocks.importBatch,
  recordImportError: importMocks.recordImportError,
}))

const fakeDb = {} as AppDatabase
const NEVER_POLL = 1e9

function batch(cursor: number, fetchedCount: number): IMessageBatch {
  return {
    cursor,
    fetchedCount,
    chats: [],
    handles: [],
    messages: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  importMocks.getLastImportedRowid.mockReturnValue(0)
  readerMocks.LocalIMessageReader.mockImplementation(function LocalIMessageReaderMock() {
    return {
      buildBatch: readerMocks.buildBatch,
      close: readerMocks.close,
    }
  })
})

describe('startIMessageSync', () => {
  it('can catch up through multiple local message batches in one explicit server sync', async () => {
    readerMocks.buildBatch.mockReturnValueOnce(batch(2, 2)).mockReturnValueOnce(batch(3, 1))
    importMocks.importBatch
      .mockReturnValueOnce({ cursor: 2, importedMessages: 2 })
      .mockReturnValueOnce({ cursor: 3, importedMessages: 1 })

    const controller = startIMessageSync(fakeDb, {
      batchSize: 2,
      pollIntervalMs: NEVER_POLL,
      startOnCreate: false,
    })

    const final = await controller.syncNow({ catchUp: true })

    expect(readerMocks.buildBatch).toHaveBeenNthCalledWith(1, 0, 2)
    expect(readerMocks.buildBatch).toHaveBeenNthCalledWith(2, 2, 2)
    expect(importMocks.importBatch).toHaveBeenCalledTimes(2)
    expect(readerMocks.close).toHaveBeenCalledTimes(1)
    expect(final).toEqual({
      state: 'idle',
      cursor: 3,
      importedMessages: 3,
      hasMore: false,
    })
    expect(controller.getStatus()).toEqual(final)
  })

  it('keeps the default explicit sync to one batch so scheduled follow-up can coalesce', async () => {
    readerMocks.buildBatch.mockReturnValueOnce(batch(2, 2))
    importMocks.importBatch.mockReturnValueOnce({ cursor: 2, importedMessages: 2 })

    const controller = startIMessageSync(fakeDb, {
      batchSize: 2,
      pollIntervalMs: NEVER_POLL,
      startOnCreate: false,
    })

    const final = await controller.syncNow()

    expect(readerMocks.buildBatch).toHaveBeenCalledTimes(1)
    expect(final).toEqual({
      state: 'idle',
      cursor: 2,
      importedMessages: 2,
      hasMore: true,
    })
  })

  it('continues catch-up after an in-flight one-batch sync reports more rows', async () => {
    readerMocks.buildBatch.mockReturnValueOnce(batch(2, 2)).mockReturnValueOnce(batch(3, 1))
    importMocks.importBatch
      .mockReturnValueOnce({ cursor: 2, importedMessages: 2 })
      .mockReturnValueOnce({ cursor: 3, importedMessages: 1 })

    const controller = startIMessageSync(fakeDb, {
      batchSize: 2,
      pollIntervalMs: NEVER_POLL,
      startOnCreate: false,
    })

    const first = controller.syncNow()
    const catchUp = controller.syncNow({ catchUp: true })

    await expect(first).resolves.toEqual({
      state: 'idle',
      cursor: 2,
      importedMessages: 2,
      hasMore: true,
    })
    await expect(catchUp).resolves.toEqual({
      state: 'idle',
      cursor: 3,
      importedMessages: 1,
      hasMore: false,
    })
    expect(readerMocks.buildBatch).toHaveBeenCalledTimes(2)
  })

  it('records import errors and returns an error status instead of throwing', async () => {
    readerMocks.buildBatch.mockImplementation(() => {
      throw new Error('Messages permission denied')
    })

    const controller = startIMessageSync(fakeDb, {
      pollIntervalMs: NEVER_POLL,
      startOnCreate: false,
    })

    const final = await controller.syncNow({ catchUp: true })

    expect(importMocks.recordImportError).toHaveBeenCalledWith(fakeDb, expect.any(Error))
    expect(final).toEqual({
      state: 'error',
      cursor: 0,
      importedMessages: 0,
      error: 'Messages permission denied',
    })
  })
})
