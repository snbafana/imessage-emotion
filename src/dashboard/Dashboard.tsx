'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Avatar } from '@base-ui/react/avatar'
import { Button } from '@base-ui/react/button'
import EmotionTimeline from './EmotionTimeline'
import ChatPanel from './ChatPanel'
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
import './dashboard.css'

export default function Dashboard() {
  const api = useMemo(() => getDashboardApi(), [])
  const [conversations, setConversations] = useState<ConversationView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
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

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [activeId, conversations],
  )
  const selectedWindow = useMemo(
    () => windows.find((window) => window.id === selectedWindowId) ?? null,
    [selectedWindowId, windows],
  )

  const reloadConversations = useCallback(async () => {
    if (!hasConversationApi(api)) {
      setConversationLoading(false)
      setConversationError('window.ipcRenderer.listConversations is not available.')
      return
    }

    setConversationLoading(true)
    setConversationError(null)
    try {
      const next = normalizeConversations(await api.listConversations())
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
        setRun(latestRun(nextRuns))
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
        setRunError('window.ipcRenderer.getRunWindows is not available.')
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
    void reloadRun(selectedConversation)
  }, [reloadRun, selectedConversation])

  useEffect(() => {
    void reloadWindows(run)
  }, [reloadWindows, run])

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
    setActionStatus('Syncing messages...')
    await api.syncMessagesNow()
    await reloadConversations()
    setActionStatus('Messages synced.')
  }

  async function createBaselineRun() {
    if (!api?.createBaselineRun || !selectedConversation) return
    setActionStatus('Creating baseline run...')
    await api.createBaselineRun(Number(selectedConversation.rawId))
    await reloadRun(selectedConversation)
    setActionStatus('Baseline run created.')
  }

  async function refreshRun() {
    setActionStatus('Refreshing run...')
    await reloadRun(selectedConversation)
    setActionStatus('Run refreshed.')
  }

  return (
    <div className="dashboard">
      <Sidebar
        activeId={activeId}
        conversations={conversations}
        loading={conversationLoading}
        error={conversationError}
        onSelect={setActiveId}
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
            {actionStatus && <span className="action-status">{actionStatus}</span>}
          </div>
          <div className="header-actions">
            <Button className="recalc secondary" disabled={!api?.syncMessagesNow} onClick={syncMessages}>
              <RecalcIcon />
              Sync Messages
            </Button>
            <Button
              className="recalc"
              disabled={!selectedConversation || !api?.createBaselineRun}
              onClick={run ? refreshRun : createBaselineRun}
            >
              <RecalcIcon />
              {run ? 'Refresh Run' : 'Create Baseline Run'}
            </Button>
          </div>
        </header>

        <div className="body">
          <EmotionTimeline
            run={run}
            windows={windows}
            selectedId={selectedWindowId}
            loading={runLoading}
            error={runError}
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
              conversationId={selectedConversation ? Number(selectedConversation.rawId) : undefined}
              runId={run ? Number(run.rawId) : undefined}
              windowId={selectedWindow ? Number(selectedWindow.rawId) : null}
              label={selectedConversation?.title}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
