export {}

declare global {
  interface Window {
    electronAPI: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>
    }
  }
}


