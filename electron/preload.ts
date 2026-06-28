import { contextBridge, ipcRenderer } from 'electron'
import {
  API_CHANNELS,
  type AskConversationInput,
  type BaselineRunOptions,
  type ImessageEmotionApi,
  type WindowMessageSlice,
} from '../src/lib/api/types'

const appApi: ImessageEmotionApi = {
  getSyncStatus: () => ipcRenderer.invoke(API_CHANNELS.getSyncStatus),
  syncMessagesNow: () => ipcRenderer.invoke(API_CHANNELS.syncMessagesNow),
  syncContactsNow: () => ipcRenderer.invoke(API_CHANNELS.syncContactsNow),
  listConversations: () => ipcRenderer.invoke(API_CHANNELS.listConversations),
  getConversation: (conversationId: number) =>
    ipcRenderer.invoke(API_CHANNELS.getConversation, conversationId),
  createBaselineRun: (conversationId: number, options?: BaselineRunOptions) =>
    ipcRenderer.invoke(API_CHANNELS.createBaselineRun, conversationId, options),
  listRuns: (conversationId: number) => ipcRenderer.invoke(API_CHANNELS.listRuns, conversationId),
  getRunWindows: (runId: number) => ipcRenderer.invoke(API_CHANNELS.getRunWindows, runId),
  getWindowMessages: (windowId: number, slice?: WindowMessageSlice) =>
    ipcRenderer.invoke(API_CHANNELS.getWindowMessages, windowId, slice),
  askConversation: (input: AskConversationInput) =>
    ipcRenderer.invoke(API_CHANNELS.askConversation, input),
}

contextBridge.exposeInMainWorld('ipcRenderer', appApi)
