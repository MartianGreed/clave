import type { AdapterFactory } from '../adapter'
import { ClaudeAdapter } from './claude'
import { CodexAdapter } from './codex'
import { OpenCodeAdapter } from './opencode'
import { PiAdapter } from './pi'

export const createAdapter: AdapterFactory = (launch, emit) => {
  switch (launch.options.provider) {
    case 'claude':
      return new ClaudeAdapter(launch, emit)
    case 'codex':
      return new CodexAdapter(launch, emit)
    case 'opencode':
      return new OpenCodeAdapter(launch, emit)
    case 'pi':
      return new PiAdapter(launch, emit)
    default:
      throw new Error('Unsupported conversation provider')
  }
}
