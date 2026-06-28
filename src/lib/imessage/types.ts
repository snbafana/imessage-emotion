export interface IMessageHandle {
  id: number
  identifier: string
  service: string
}

export interface IMessageChat {
  id: number
  identifier: string
  displayName: string | null
  isGroup: boolean
  participants: IMessageHandle[]
}

export interface IMessageMessage {
  id: number
  guid: string
  chatId: number
  text: string | null
  timestamp: number
  isFromMe: boolean
  isRead: boolean
  readAt: number | null
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  errorCode: number
  hasAttachments: boolean
  sender: IMessageHandle | null
}

export interface IMessageBatch {
  cursor: number
  fetchedCount: number
  chats: IMessageChat[]
  messages: IMessageMessage[]
  handles: IMessageHandle[]
}
