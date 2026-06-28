import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('imessageEmotion', {
  appName: 'iMessage Emotion',
});
