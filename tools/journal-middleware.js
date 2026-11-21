/**
 * Middleware browser-sync : reçoit les lots d'événements de src/game/journal.js
 * et les ajoute à jeu.log, une ligne par événement :
 *   <horodatage local ISO-8601 avec fuseau> [<NIVEAU>] <type> <JSON complet de l'événement>
 * Aucune troncature.
 */
const fs = require('fs')
const path = require('path')

const LOG_FILE = path.resolve(__dirname, '../jeu.log')

function localIso (date) {
  const pad = n => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
}

module.exports = function journalMiddleware (req, res, next) {
  if (req.url !== '/__jeu-log' || req.method !== 'POST') return next()
  let body = ''
  req.setEncoding('utf8')
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const now = localIso(new Date())
    let lines
    try {
      const events = JSON.parse(body)
      lines = events.map(e => now + ' [' + e.level + '] ' + e.type + ' ' + JSON.stringify(e)).join('\n') + '\n'
    } catch (err) {
      lines = now + ' [ERROR] journal.parse ' + JSON.stringify({ error: String(err), body }) + '\n'
    }
    fs.appendFile(LOG_FILE, lines, err => {
      res.statusCode = err ? 500 : 204
      res.end()
    })
  })
}
