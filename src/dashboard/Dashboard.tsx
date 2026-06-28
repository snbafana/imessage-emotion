'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEveAgent } from 'eve/react'
import { Avatar } from '@base-ui/react/avatar'
import { Button } from '@base-ui/react/button'
import EmotionTimeline from './EmotionTimeline'
import type { AnalysisSetupPlan, AnalysisSetupValue } from './EmotionTimeline'
import ChatPanel from './ChatPanel'
import Inspector from './Inspector'
import Sidebar from './Sidebar'
import TwoTierRoom from './TwoTierRoom'
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
import { RecalcIcon, SettingsIcon } from './icons'
import type { AnalysisRunOptions, SyncStatus } from '../lib/api/types'
import { planCappedRunWindowConfig, planRunWindowRanges } from '../lib/windows/windows'
import './dashboard.css'

const DEFAULT_ANALYSIS_SETUP: AnalysisSetupValue = {
  planner: 'capped',
  provider: 'openrouter',
  effort: 'medium',
  model: 'google/gemini-2.5-flash',
  maxWindows: 200,
  overlapPercent: 25,
  contextMessages: 80,
  focalMessages: 40,
  minFocalMessages: 20,
}

export default function Dashboard({ onOpenSettings }: { onOpenSettings?: () => void }) {
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
  const [analysisSetup, setAnalysisSetup] =
    useState<AnalysisSetupValue>(DEFAULT_ANALYSIS_SETUP)
  const [analysisRunning, setAnalysisRunning] = useState(false)
  const [showTwoTier, setShowTwoTier] = useState(false)
  // null = no active search (show everything); a Set = the conversation ids
  // whose participants matched the contacts FTS query.
  const [matchedConversationIds, setMatchedConversationIds] = useState<Set<string> | null>(null)

  const visibleConversations = useMemo(
    () => {
      const query = searchQuery.trim().toLowerCase()
      if (!query) return conversations
      return conversations.filter(
        (conversation) =>
          conversationMatchesQuery(conversation, query) ||
          matchedConversationIds?.has(String(conversation.rawId)),
      )
    },
    [conversations, matchedConversationIds, searchQuery],
  )

  const chat = useEveAgent()
  const chatBusy = chat.status === 'submitted' || chat.status === 'streaming'
  const recomputingRef = useRef(false)

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
  const setupPlan = useMemo(
    () =>
      selectedConversation
        ? buildAnalysisSetupPlan(analysisSetup, selectedConversation.messageCount)
        : null,
    [analysisSetup, selectedConversation],
  )

  const reloadConversations = useCallback(async () => {
    if (!hasConversationApi(api)) {
      setConversationLoading(false)
      setConversationError('Dashboard API is not available.')
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
    if (!selectedConversation || chatBusy || !setupPlan || setupPlan.error) return
    recomputingRef.current = true
    setActionStatus(`Recomputing with ${analysisSetup.model}...`)
    void chat.send({
      message: [
        'Recompute the emotion timeline for this conversation end-to-end with the Ax scorer.',
        `Use model ${analysisSetup.model}, provider ${analysisSetup.provider}, effort ${analysisSetup.effort}.`,
        `Use maxWindows ${analysisSetup.maxWindows}, overlapPercent ${analysisSetup.overlapPercent}, and messageCount ${selectedConversation.messageCount}.`,
        'Score window by window, then summarize the arc.',
      ].join(' '),
      clientContext: {
        action: 'recompute',
        conversationId: Number(selectedConversation.rawId),
        messageCount: selectedConversation.messageCount,
        analysisSetup,
      },
    })
  }

  async function createConfiguredAnalysisRun() {
    if (!selectedConversation || !api?.createAnalysisRun || !setupPlan || setupPlan.error) return

    setAnalysisRunning(true)
    setRunError(null)
    setActionStatus(`Running Ax analysis with ${analysisSetup.model}...`)
    try {
      const options = analysisRunOptions(analysisSetup, setupPlan)
      await api.createAnalysisRun(Number(selectedConversation.rawId), options)
      await reloadConversations()
      await reloadRun(selectedConversation)
      setActionStatus(`Analysis finished with ${analysisSetup.model}.`)
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Analysis run failed.')
      setActionStatus(null)
    } finally {
      setAnalysisRunning(false)
    }
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
            {onOpenSettings && (
              <Button className="recalc secondary" onClick={onOpenSettings}>
                <SettingsIcon />
                Settings
              </Button>
            )}
            <Button
              className="recalc secondary"
              disabled={!api?.syncMessagesNow || isSyncing}
              onClick={syncMessages}
            >
              <RecalcIcon />
              {isSyncing ? 'Syncing...' : 'Sync Data'}
            </Button>
            <Button
              className="recalc secondary"
              disabled={!selectedConversation || showTwoTier}
              onClick={() => setShowTwoTier(true)}
            >
              RoBERTa → RLM
            </Button>
            <Button
              className="recalc"
              disabled={!selectedConversation || chatBusy || !setupPlan || Boolean(setupPlan.error)}
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
            conversation={selectedConversation}
            setup={analysisSetup}
            setupPlan={setupPlan}
            setupRunning={analysisRunning}
            onChangeSetup={(patch) =>
              setAnalysisSetup((current) => ({ ...current, ...patch }))
            }
            onRunSetup={createConfiguredAnalysisRun}
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

      {showTwoTier && selectedConversation && (
        <TwoTierRoom
          conversationId={Number(selectedConversation.rawId)}
          title={selectedConversation.title}
          onClose={() => setShowTwoTier(false)}
          onDone={() => {
            void reloadRun(selectedConversation)
          }}
        />
      )}
    </div>
  )
}

function buildAnalysisSetupPlan(
  setup: AnalysisSetupValue,
  messageCount: number,
): AnalysisSetupPlan {
  try {
    const overlapPercent = clampInteger(setup.overlapPercent, 10, 40)
    const maxWindows = clampInteger(setup.maxWindows, 1, 200)
    const config =
      setup.planner === 'capped'
        ? planCappedRunWindowConfig(messageCount, { maxWindows, overlapPercent }).config
        : {
            mode: 'comparative-message-count' as const,
            contextMessages: clampInteger(setup.contextMessages, 1, Math.max(1, messageCount)),
            focalMessages: clampInteger(setup.focalMessages, 1, Math.max(1, messageCount)),
            stride: Math.max(
              1,
              Math.round(
                clampInteger(setup.focalMessages, 1, Math.max(1, messageCount)) *
                  (1 - overlapPercent / 100),
              ),
            ),
            minFocalMessages: clampInteger(
              setup.minFocalMessages,
              1,
              Math.max(1, clampInteger(setup.focalMessages, 1, Math.max(1, messageCount))),
            ),
          }
    const windowCount = planRunWindowRanges(messageCount, config).length
    const error =
      windowCount > maxWindows
        ? `Estimated ${windowCount} windows exceeds the ${maxWindows} window cap.`
        : windowCount === 0
          ? 'This conversation is too short for the selected context and focal window.'
          : null
    return { config, windowCount, error }
  } catch (error) {
    return {
      config: {
        mode: 'comparative-message-count',
        contextMessages: 0,
        focalMessages: 0,
        stride: 0,
        minFocalMessages: 0,
      },
      windowCount: 0,
      error: error instanceof Error ? error.message : 'Invalid analysis setup.',
    }
  }
}

function analysisRunOptions(
  setup: AnalysisSetupValue,
  plan: AnalysisSetupPlan,
): AnalysisRunOptions {
  return {
    ...plan.config,
    scorerConfig: {
      provider: setup.provider,
      effort: setup.effort,
      model: setup.model.trim(),
      promptKey: 'dashboard-configured-ax-v1',
      label:
        setup.planner === 'capped'
          ? `Ax capped ${setup.overlapPercent}% overlap`
          : `Ax configured ${setup.overlapPercent}% overlap`,
      overlapPercent: setup.overlapPercent,
      maxWindows: setup.maxWindows,
      estimatedWindowCount: plan.windowCount,
      planner: setup.planner,
    },
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function conversationMatchesQuery(conversation: ConversationView, query: string): boolean {
  return [conversation.title, conversation.participantSummary, String(conversation.rawId)]
    .join(' ')
    .toLowerCase()
    .includes(query)
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
