import type { EnvThawApi } from '../shared/ipc-types'

declare global {
  interface Window {
    envthaw: EnvThawApi
  }
}

export {}
