// The result of the last "Test connection" (FL answering a ping), shown in
// the top bar and in setup.
export type Connection = {
  state: 'unknown' | 'checking' | 'ok' | 'fail'
  message: string // '' for unknown/checking; the answer time or the error
}
