/** Read model of the existing Exos transport log. Names are captured at send time. */
export interface ExchangeHistoryEndpoint {
  sessionId: string
  name: string
  groupId: string | null
  groupName: string | null
}
export interface ExchangeHistoryMessage {
  ts: string
  sender: ExchangeHistoryEndpoint
  target: ExchangeHistoryEndpoint
  text: string
  delivered: boolean
  checkpoint: boolean
}
export interface ExchangeHistoryPage {
  messages: ExchangeHistoryMessage[]
  /** Byte cursor for the next older page; null means the start of the log. */
  before: number | null
  skippedLines: number
}
