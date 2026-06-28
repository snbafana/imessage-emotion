import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@base-ui/react/button'
import { Separator } from '@base-ui/react/separator'
import type { OnboardingStatus, SetupPermissionStatus, SyncStatus } from '../lib/api/types'
import type { DashboardApi } from './data'
import { ArrowLeftIcon, RecalcIcon } from './icons'

type Props = {
  api: DashboardApi | null
  initialStatus: OnboardingStatus | null
  continueLabel?: string
  showBackButton?: boolean
  onContinue: () => void
  onStatusChange: (status: OnboardingStatus) => void
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function statusLabel(status: SetupPermissionStatus): string {
  switch (status.state) {
    case 'authorized':
    case 'limited':
      return 'Ready'
    case 'not_determined':
      return 'Not requested'
    case 'needs_full_disk_access':
      return 'Needs access'
    case 'denied':
    case 'restricted':
      return 'Blocked'
    case 'missing':
      return 'Missing'
    case 'blocked':
    case 'check_failed':
      return 'Check failed'
    case 'unknown':
      return 'Unknown'
  }
}

function syncLabel(sync: SyncStatus): string {
  if (sync.messages.state === 'syncing') return 'Syncing local Messages'
  if (sync.contacts.state === 'syncing') return 'Syncing Contacts'
  if (sync.messages.state === 'error') return 'Messages sync needs attention'
  if (sync.contacts.state === 'error') return 'Contacts sync needs attention'
  return 'Idle'
}

function syncError(sync: SyncStatus): string | null {
  return sync.messages.error ?? sync.contacts.error ?? null
}

function syncDetail(sync: SyncStatus): string | null {
  const parts = []
  if (sync.messages.importedMessages > 0) {
    parts.push(`${formatCount(sync.messages.importedMessages)} messages imported`)
  }
  if (sync.contacts.scannedContacts > 0 || sync.contacts.resolvedHandles > 0) {
    parts.push(
      `${formatCount(sync.contacts.scannedContacts)} contacts scanned`,
      `${formatCount(sync.contacts.resolvedHandles)} handles resolved`,
    )
  }
  if (sync.messages.hasMore) parts.push('Messages sync has more to import')
  return parts.length > 0 ? parts.join(', ') : null
}

function syncingStatus(status: OnboardingStatus, target: 'messages' | 'contacts' | 'all'): OnboardingStatus {
  const next: OnboardingStatus = {
    ...status,
    sync: {
      messages: { ...status.sync.messages },
      contacts: { ...status.sync.contacts },
    },
  }
  if (target === 'messages' || target === 'all') {
    next.sync.messages = { ...next.sync.messages, state: 'syncing', importedMessages: 0 }
  }
  if (target === 'contacts' || target === 'all') {
    next.sync.contacts = { ...next.sync.contacts, state: 'syncing', scannedContacts: 0, resolvedHandles: 0 }
  }
  return next
}

export default function Onboarding({
  api,
  initialStatus,
  continueLabel = 'Continue',
  showBackButton = false,
  onContinue,
  onStatusChange,
}: Props) {
  const [status, setStatus] = useState<OnboardingStatus | null>(initialStatus)
  const [loading, setLoading] = useState(!initialStatus)
  const [error, setError] = useState<string | null>(null)

  const commitStatus = useCallback(
    (next: OnboardingStatus) => {
      setStatus(next)
      onStatusChange(next)
    },
    [onStatusChange],
  )

  const refresh = useCallback(async () => {
    if (!api?.getOnboardingStatus) {
      setError('The local sync API is not available.')
      setLoading(false)
      return
    }
    try {
      const next = await api.getOnboardingStatus()
      commitStatus(next)
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    } finally {
      setLoading(false)
    }
  }, [api, commitStatus])

  useEffect(() => {
    if (!initialStatus) void refresh()
  }, [initialStatus, refresh])

  const canContinue = useMemo(
    () => Boolean(status?.ready && !syncError(status.sync)),
    [status],
  )

  async function syncMessages() {
    if (!api?.syncMessagesNow || !status) return
    commitStatus(syncingStatus(status, 'messages'))
    try {
      const sync = await api.syncMessagesNow()
      commitStatus({ ...status, sync })
      setError(syncError(sync))
      await refresh()
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError))
      await refresh()
    }
  }

  async function syncContacts() {
    if (!api?.syncContactsNow || !status) return
    commitStatus(syncingStatus(status, 'contacts'))
    try {
      const sync = await api.syncContactsNow()
      commitStatus({ ...status, sync })
      setError(syncError(sync))
      await refresh()
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError))
      await refresh()
    }
  }

  async function syncLocalData() {
    if (!api?.syncLocalDataNow || !status) return
    commitStatus(syncingStatus(status, 'all'))
    try {
      const next = await api.syncLocalDataNow()
      commitStatus(next)
      setError(syncError(next.sync))
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError))
      await refresh()
    } finally {
      setLoading(false)
    }
  }

  async function openSettings(permission: SetupPermissionStatus) {
    try {
      if (permission.settingsTarget === 'contacts') {
        await api?.openContactsSettings()
      } else {
        await api?.openFullDiskAccessSettings()
      }
      setError(null)
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError))
    }
    await refresh()
  }

  if (loading || !status) {
    return (
      <div className="setup-screen">
        <div className="setup-shell">
          <span className="label">Setup</span>
          <h1>Checking local access</h1>
          {error ? <p className="setup-error">{error}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="setup-screen">
      <div className="setup-shell">
        <header className="setup-header">
          <div>
            <span className="label">Setup</span>
            <h1>Local Messages and Contacts sync</h1>
          </div>
          <div className="setup-header-actions">
            {showBackButton ? (
              <Button className="setup-back" onClick={onContinue}>
                <ArrowLeftIcon />
                Back to dashboard
              </Button>
            ) : null}
            <span className="sync-pill">{syncLabel(status.sync)}</span>
          </div>
        </header>

        <Separator className="setup-separator" />

        <section className="setup-list">
          {status.permissions.map((permission) => (
            <div className="setup-row" key={permission.key}>
              <div className="setup-row-main">
                <div className="setup-row-title-line">
                  <span className={`setup-state-dot setup-state-dot-${permission.state}`} />
                  <span className="setup-row-title">{permission.label}</span>
                  <span className={`setup-state setup-state-${permission.state}`}>
                    {statusLabel(permission)}
                  </span>
                </div>
                <span className="setup-row-copy">{permission.summary}</span>
                {permission.error ? <span className="setup-error">{permission.error}</span> : null}
              </div>
              <div className="setup-row-actions">
                <Button className="ghost-button" onClick={() => void openSettings(permission)}>
                  {permission.actionLabel}
                </Button>
                {permission.key === 'messages_full_disk_access' ? (
                  <Button
                    className="setup-action"
                    disabled={!permission.canSync || status.sync.messages.state === 'syncing'}
                    onClick={() => void syncMessages()}
                  >
                    <RecalcIcon />
                    Sync
                  </Button>
                ) : (
                  <Button
                    className="setup-action"
                    disabled={!permission.canSync || status.sync.contacts.state === 'syncing'}
                    onClick={() => void syncContacts()}
                  >
                    <RecalcIcon />
                    Sync
                  </Button>
                )}
              </div>
            </div>
          ))}
        </section>

        <Separator className="setup-separator" />

        <section className="setup-counts" aria-label="Local sync counts">
          <div>
            <span className="setup-count">{formatCount(status.counts.conversations)}</span>
            <span className="setup-count-label">Conversations</span>
          </div>
          <div>
            <span className="setup-count">{formatCount(status.counts.messages)}</span>
            <span className="setup-count-label">Messages</span>
          </div>
          <div>
            <span className="setup-count">{formatCount(status.counts.contacts)}</span>
            <span className="setup-count-label">Contacts</span>
          </div>
          <div>
            <span className="setup-count">{formatCount(status.counts.resolvedContacts)}</span>
            <span className="setup-count-label">Resolved handles</span>
          </div>
        </section>

        <footer className="setup-footer">
          <div className="setup-footer-copy">
            <span className="setup-footnote">Counts only. Message text and contact details stay out of setup.</span>
            {syncDetail(status.sync) ? <span className="setup-sync-detail">{syncDetail(status.sync)}</span> : null}
            {error ?? syncError(status.sync) ? (
              <span className="setup-error">{error ?? syncError(status.sync)}</span>
            ) : null}
          </div>
          <div className="setup-footer-actions">
            <Button
              className="setup-action"
              disabled={
                !status.permissions.every((permission) => permission.canSync) ||
                status.sync.messages.state === 'syncing' ||
                status.sync.contacts.state === 'syncing'
              }
              onClick={() => void syncLocalData()}
            >
              <RecalcIcon />
              Start local sync
            </Button>
            <Button className="setup-continue" disabled={!canContinue} onClick={onContinue}>
              {continueLabel}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}
