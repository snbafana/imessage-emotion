'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEveAgent } from 'eve/react'
import { Avatar } from '@base-ui/react/avatar'
import { Button } from '@base-ui/react/button'
import EmotionTimeline from './EmotionTimeline'
import ChatPanel from './ChatPanel'
import ControlRoom from './ControlRoom'
import Inspector from './Inspector'
import Sidebar from './Sidebar'
import { getDashboardApi } from './api'
import {
  formatDateRange,
  formatMessageCount,
  getWindowMessages,
  hasConversationApi,
  latestRun,
  normalizeConversations,
  normalizeRuns,
  normalizeWindows,
  type ConversationView,
  type MessageView,
  type RunView,
  type WindowView,
} from './data'
import { RecalcIcon } from './icons'
import type { SyncStatus } from '../lib/api/types'
import './dashboard.css'

export default function Dashboard() {
  const api = useMemo(() => getDashboardApi(), [])
  const [conversations, setConversations] = useState<ConversationView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunView[]>([])
  const [run, setRun] = useState<RunView | null>(null)
  const [windows, setWindows] = useState<WindowView[]>([])
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null)
  const [contextMessages, setContextMessages] = useState<MessageView[]>([])
  const [focalMessages, setFocalMessages] = useState<MessageView[]>([])
  const [conversationLoading, setConversationLoading] = useState(true)
  const [runLoading, setRunLoading] = useState(false)
  const [windowLoading, setWindowLoading] = useState(false)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [windowError, setWindowError] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // null = no active search (show everything); a Set = the conversation ids
  // whose participants matched the contacts FTS query.
  const [matchedConversationIds, setMatchedConversationIds] = useState<Set<string> | null>(null)

  const visibleConversations = useMemo(
    () =>
      matchedConversationIds === null
        ? conversations
        : conversations.filter((conversation) =>
            matchedConversationIds.has(String(conversation.rawId)),
          ),
    [conversations, matchedConversationIds],
  )

  const chat = useEveAgent()
  const chatBusy = chat.status === 'submitted' || chat.status === 'streaming'
  const recomputingRef = useRef(false)
  const [showControlRoom, setShowControlRoom] = useState(false)

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  )
  const selectedWindow = useMemo(
    () => windows.find((window) => window.id === selectedWindowId) ?? null,
    [selectedWindowId, windows],
  )
  const isSyncing =
    syncStatus?.messages.state === 'syncing' || syncStatus?.contacts.state === 'syncing'
  const syncStatusLine = syncError ?? actionStatus ?? formatSyncStatus(syncStatus)

  const reloadConversations = useCallback(async () => {
    if (!hasConversationApi(api)) {
      setConversationLoading(false)
      setConversationError('Dashboard API is not available.')
      return
    }

    setConversationLoading(true)
    setConversationError(null)
    try {
      // Only surface conversations that have been analyzed (have a run).
      const next = normalizeConversations(await api.listConversations()).filter(
        (conversation) => conversation.latestRun != null,
      )
      setConversations(next)
      setActiveId((current) =>
        current && next.some((conversation) => conversation.id === current)
          ? current
          : next[0]?.id ?? null,
      )
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : 'Could not load conversations.')
    } finally {
      setConversationLoading(false)
    }
  }, [api])

  const reloadRun = useCallback(
    async (conversation: ConversationView | null) => {
      setRun(null)
      setRuns([])
      setWindows([])
      setSelectedWindowId(null)
      setContextMessages([])
      setFocalMessages([])
      setRunError(null)

      if (!conversation) return

      setRunLoading(true)
      try {
        let nextRuns: RunView[] = []
        if (api?.getConversation) {
          nextRuns = normalizeRuns(await api.getConversation(Number(conversation.rawId)))
        }
        if (api?.listRuns) {
          nextRuns = normalizeRuns(await api.listRuns(Number(conversation.rawId)))
        }
        if (nextRuns.length === 0 && conversation.latestRun) {
          nextRuns = [conversation.latestRun]
        }
        const orderedRuns = [...nextRuns].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        setRuns(orderedRuns)
        setRun(latestRun(orderedRuns))
      } catch (error) {
        setRunError(error instanceof Error ? error.message : 'Could not load analysis runs.')
      } finally {
        setRunLoading(false)
      }
    },
    [api],
  )

  const reloadWindows = useCallback(
    async (activeRun: RunView | null) => {
      setWindows([])
      setSelectedWindowId(null)
      setContextMessages([])
      setFocalMessages([])
      setRunError(null)

      if (!activeRun) return
      if (!api?.getRunWindows) {
        setRunError('Run window API is not available.')
        return
      }

      setRunLoading(true)
      try {
        const nextWindows = normalizeWindows(await api.getRunWindows(Number(activeRun.rawId)))
        setWindows(nextWindows)
        setSelectedWindowId(nextWindows.find((window) => window.state === 'scored')?.id ?? nextWindows[0]?.id ?? null)
      } catch (error) {
        setRunError(error instanceof Error ? error.message : 'Could not load run windows.')
      } finally {
        setRunLoading(false)
      }
    },
    [api],
  )

  useEffect(() => {
    void reloadConversations()
  }, [reloadConversations])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || !api?.searchContacts) {
      setMatchedConversationIds(null)
      return
    }

    let cancelled = false
    const handle = window.setTimeout(async () => {
      try {
        const hits = await api.searchContacts(query)
        if (cancelled) return
        const ids = new Set<string>()
        for (const hit of hits) {
          for (const conversationId of hit.conversationIds) ids.add(String(conversationId))
        }
        setMatchedConversationIds(ids)
      } catch {
        if (!cancelled) setMatchedConversationIds(new Set())
      }
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [api, searchQuery])

  useEffect(() => {
    void reloadRun(selectedConversation)
  }, [reloadRun, selectedConversation])

  useEffect(() => {
    void reloadWindows(run)
  }, [reloadWindows, run])

  useEffect(() => {
    let cancelled = false

    async function loadSyncStatus() {
      if (!api?.getSyncStatus) return
      try {
        const nextStatus = await api.getSyncStatus()
        if (!cancelled) {
          setSyncStatus(nextStatus)
          setSyncError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setSyncError(error instanceof Error ? error.message : 'Could not load sync status.')
        }
      }
    }

    void loadSyncStatus()
    const interval = window.setInterval(() => void loadSyncStatus(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [api])

  useEffect(() => {
    let cancelled = false

    async function loadMessages() {
      setContextMessages([])
      setFocalMessages([])
      setWindowError(null)

      if (!selectedWindow || !api?.getWindowMessages) return

      setWindowLoading(true)
      try {
        const [context, focal] = await Promise.all([
          getWindowMessages(api, selectedWindow.rawId, 'context'),
          getWindowMessages(api, selectedWindow.rawId, 'focal'),
        ])
        if (!cancelled) {
          setContextMessages(context)
          setFocalMessages(focal)
        }
      } catch (error) {
        if (!cancelled) {
          setWindowError(error instanceof Error ? error.message : 'Could not load window messages.')
        }
      } finally {
        if (!cancelled) setWindowLoading(false)
      }
    }

    void loadMessages()
    return () => {
      cancelled = true
    }
  }, [api, selectedWindow])

  async function syncMessages() {
    if (!api?.syncMessagesNow) return
    setActionStatus('Syncing messages and contacts...')
    setSyncError(null)
    try {
      const messageStatus = await api.syncMessagesNow()
      setSyncStatus(messageStatus)
      const finalStatus = api.syncContactsNow ? await api.syncContactsNow() : messageStatus
      setSyncStatus(finalStatus)
      await reloadConversations()
      setActionStatus(formatSyncStatus(finalStatus))
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Sync failed.')
      setActionStatus(null)
    }
  }

  // Drive a full ax recompute through the eve agent so it streams window-by-window
  // in the chat; reload the timeline once the turn finishes.
  function recomputeWithAx() {
    if (!selectedConversation || chatBusy) return
    recomputingRef.current = true
    setShowControlRoom(true)
    setActionStatus('Recomputing with the ax scorer — streaming in chat…')
    void chat.send({
      message: `Recompute the emotion timeline for this conversation end-to-end with the ax scorer at medium effort, window by window, then summarize the arc.`,
      clientContext: { action: 'recompute', conversationId: Number(selectedConversation.rawId) },
    })
  }

  function selectRun(runId: string) {
    const nextRun = runs.find((item) => item.id === runId)
    if (nextRun) setRun(nextRun)
  }

  useEffect(() => {
    if (recomputingRef.current && !chatBusy) {
      recomputingRef.current = false
      setActionStatus('Recompute finished.')
      void reloadRun(selectedConversation)
    }
  }, [chatBusy, reloadRun, selectedConversation])

  return (
    <div className="dashboard">
      <Sidebar
        activeId={activeId}
        conversations={visibleConversations}
        loading={conversationLoading}
        error={conversationError}
        onSelect={setActiveId}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <div className="main">
        <header className="header-bar">
          <Avatar.Root
            className="avatar"
            style={{ background: selectedConversation?.avatar ?? '#1f44ff' }}
          >
            <Avatar.Fallback>{selectedConversation?.initial ?? '?'}</Avatar.Fallback>
          </Avatar.Root>
          <div className="id">
            <span className="name">{selectedConversation?.title ?? 'No conversation selected'}</span>
            <span className="range">
              {selectedConversation
                ? `${formatDateRange(selectedConversation.firstMessageAt, selectedConversation.lastMessageAt)} · ${formatMessageCount(selectedConversation.messageCount)} messages · ${selectedConversation.participantSummary}`
                : 'Sync messages to populate the dashboard'}
            </span>
            {syncStatusLine && (
              <span className={`action-status${syncError ? ' error' : ''}`}>{syncStatusLine}</span>
            )}
          </div>
          <div className="header-actions">
            <Button
              className="recalc secondary"
              disabled={!api?.syncMessagesNow || isSyncing}
              onClick={syncMessages}
            >
              <RecalcIcon />
              {isSyncing ? 'Syncing...' : 'Sync Data'}
            </Button>
            <Button
              className="recalc"
              disabled={!selectedConversation || chatBusy}
              onClick={recomputeWithAx}
            >
              <RecalcIcon />
              {chatBusy ? 'Recomputing…' : 'Recompute (ax)'}
            </Button>
          </div>
        </header>

        <div className="body">
          <EmotionTimeline
            run={run}
            runs={runs}
            windows={windows}
            selectedId={selectedWindowId}
            selectedRunId={run?.id ?? null}
            loading={runLoading}
            error={runError}
            onSelectRun={selectRun}
            onSelectWindow={setSelectedWindowId}
          />
          <div className="lower-row">
            <Inspector
              run={run}
              window={selectedWindow}
              contextMessages={contextMessages}
              focalMessages={focalMessages}
              loading={windowLoading}
              error={windowError}
            />
            <ChatPanel
              agent={chat}
              conversationId={selectedConversation ? Number(selectedConversation.rawId) : undefined}
              runId={run ? Number(run.rawId) : undefined}
              windowId={selectedWindow ? Number(selectedWindow.rawId) : null}
              label={selectedConversation?.title}
            />
          </div>
        </div>
      </div>

      {showControlRoom && (
        <ControlRoom agent={chat} title={selectedConversation?.title} onClose={() => setShowControlRoom(false)} />
      )}
    </div>
  )
}

function formatSyncStatus(status: SyncStatus | null): string | null {
  if (!status) return null
  const messageError = status.messages.error
  const contactsError = status.contacts.error
  if (messageError || contactsError) return messageError ?? contactsError ?? null
  if (status.messages.state === 'syncing') {
    return `Syncing messages at row ${formatMessageCount(status.messages.cursor)}...`
  }
  if (status.contacts.state === 'syncing') return 'Syncing contacts...'
  return null
}
