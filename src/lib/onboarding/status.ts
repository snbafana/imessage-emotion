import { checkContactsReadiness } from '../contacts/reader'
import { getPrivacySafeCounts, type AppDatabase, type PrivacySafeCounts } from '../db/schema'
import { checkIMessageReadiness } from '../imessage/reader'
import type { OnboardingStatus, SetupPermissionStatus, SyncStatus } from '../api/types'

const EMPTY_COUNTS: PrivacySafeCounts = {
  conversations: 0,
  messages: 0,
  contacts: 0,
  resolvedContacts: 0,
  lastMessageAt: null,
  lastImportedAt: null,
}

export interface BuildOnboardingStatusOptions {
  chatDbPath?: string
}

export function buildOnboardingStatus(
  db: AppDatabase | null,
  sync: SyncStatus,
  options: BuildOnboardingStatusOptions = {},
): OnboardingStatus {
  const messages = checkIMessageReadiness(options.chatDbPath)
  const contacts = checkContactsReadiness()
  const counts = db ? getPrivacySafeCounts(db) : EMPTY_COUNTS
  const permissionsReady =
    messages.state === 'authorized' &&
    (contacts.state === 'authorized' || contacts.state === 'limited')
  const permissions: SetupPermissionStatus[] = [
    {
      key: 'messages_full_disk_access',
      label: 'Local Messages sync',
      state: messages.state,
      canSync: messages.state === 'authorized',
      summary: messages.summary,
      actionLabel: 'Open Full Disk Access',
      settingsTarget: 'full_disk_access',
      error: messages.error,
    },
    {
      key: 'contacts',
      label: 'Contacts sync',
      state: contacts.state,
      canSync: contacts.canSync,
      summary: contacts.summary,
      actionLabel: 'Open Contacts Privacy',
      settingsTarget: 'contacts',
      error: contacts.error,
    },
  ]

  return {
    permissions,
    sync,
    counts,
    ready: permissionsReady && counts.messages > 0,
  }
}
