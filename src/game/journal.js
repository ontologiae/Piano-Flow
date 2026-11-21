/* global __DEBUG__ */
/**
 * Journal de partie, actif en développement (npm start) uniquement.
 *
 * Chaque événement est mis en file et envoyé par lots au serveur browser-sync,
 * qui l'ajoute à jeu.log à la racine du projet (voir tools/journal-middleware.js).
 * Rien n'est tronqué ni filtré côté page.
 */
const ENDPOINT = '/__jeu-log'
const session = Date.now().toString(36)
let seq = 0
let queue = []
let warned = false

export function log (level, type, data) {
  if (!__DEBUG__) return
  queue.push({
    client: new Date().toISOString(),
    ms: Math.round(window.performance ? window.performance.now() : Date.now()),
    session,
    seq: seq++,
    level,
    type,
    data
  })
}

function warnOnce (reason) {
  if (warned) return
  warned = true
  console.warn('[journal] envoi impossible vers ' + ENDPOINT + ' : ' + reason + '. Le journal de partie est perdu.')
}

function flush () {
  if (!queue.length) return
  const body = JSON.stringify(queue)
  queue = []
  window.fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    .then(res => { res.ok || warnOnce('HTTP ' + res.status) })
    .catch(err => warnOnce(String(err)))
}

if (__DEBUG__) {
  setInterval(flush, 500)
  window.addEventListener('pagehide', () => {
    if (queue.length && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, JSON.stringify(queue))
      queue = []
    }
  })
  window.addEventListener('error', event => {
    log('ERROR', 'window.error', {
      message: event.message,
      file: event.filename,
      line: event.lineno,
      col: event.colno,
      stack: event.error && event.error.stack
    })
  })
  window.addEventListener('unhandledrejection', event => {
    log('ERROR', 'unhandledrejection', { reason: String(event.reason), stack: event.reason && event.reason.stack })
  })
  log('INFO', 'session.start', { userAgent: navigator.userAgent, url: window.location.href })
}
