/**
 * Deux mains, deux zones du clavier.
 *
 * Les touches sont comparées à `event.key` en minuscules : les tableaux ci-dessous
 * décrivent donc la disposition AZERTY telle qu'elle est tapée, pas des codes physiques.
 * Une touche absente des deux tableaux est ignorée.
 */
export const HANDS = ['left', 'right']

export const LEFT_HAND_KEYS = ['a', 'z', 'e', 'r', 't', 'q', 's', 'd', 'f', 'g', 'w', 'x', 'c', 'v']
export const RIGHT_HAND_KEYS = ['y', 'u', 'i', 'o', 'p', 'h', 'j', 'k', 'l', 'm', 'b', 'n', ',', ';']

// Attribution d'une note à une main, par ordre de priorité :
// 1. le nom de la piste MIDI, si le fichier a une piste « gauche » et une piste « droite » ;
// 2. sinon la hauteur : strictement sous SPLIT_PITCH (60 = do central), main gauche.
export const TRACK_NAME_PATTERNS = {
  left: /left|gauche|\blh\b/i,
  right: /right|droite|\brh\b/i
}
export const SPLIT_PITCH = 60

// Synchronisation des deux mains.
// 'clock' : une horloge suit le tempo du joueur (rubato compris) ; voir CLOCK.
// 'wait'  : la main en avance attend l'autre ; aucune note n'est jamais manquée.
export const HAND_SYNC = 'clock'

/**
 * Horloge du mode 'clock'.
 *
 * Le tempo est un rapport k = ms réelles par ms de partition (1 = tempo de la partition,
 * 2 = deux fois plus lent). L'heure attendue d'un groupe se déduit de la dernière pression
 * (l'ancre) : ancre.réel + (t_groupe - ancre.partition) * k.
 *
 * - Une pression trop en avance sur l'heure attendue de sa note est refusée.
 * - Une pression en retard est acceptée et recale l'ancre : c'est le rubato.
 * - Une note de l'autre main est manquée si elle était déjà en retard selon l'horloge ;
 *   une pression qui sauterait une note de l'autre main pas encore due est refusée.
 * - k est estimé sur les derniers intervalles joués, en partant du tempo de la partition.
 *   Un intervalle aberrant (point d'orgue, hésitation) recale l'ancre sans changer k.
 */
export const CLOCK = {
  tempoWindow: 4, // nombre d'intervalles pour estimer le tempo
  earlyRatio: 0.35, // avance tolérée, en fraction de l'intervalle attendu…
  earlyMinMs: 120, // … bornée en ms réelles
  earlyMaxMs: 1500,
  lateMs: 150, // retard au-delà duquel une note est manquée (ms réelles)
  outlierFactor: 2.5, // un intervalle plus de 2,5 fois plus lent ou plus rapide que k ne change pas k
  tempoMin: 0.25, // bornes de k
  tempoMax: 4
}

export function otherHand (hand) {
  return hand === 'left' ? 'right' : 'left'
}

export function handForKey (event) {
  const raw = event.key || (event.keyCode ? String.fromCharCode(event.keyCode) : '')
  const key = raw.toLowerCase()
  if (LEFT_HAND_KEYS.indexOf(key) !== -1) return 'left'
  if (RIGHT_HAND_KEYS.indexOf(key) !== -1) return 'right'
  return null
}

/**
 * Associe un numéro de piste à une main d'après le nom de la piste.
 * Retourne null si le fichier n'a pas à la fois une piste gauche et une piste droite.
 */
export function trackHandsFromNames (trackNames) {
  const trackHands = {}
  const found = { left: false, right: false }
  Object.keys(trackNames).forEach(track => {
    HANDS.forEach(hand => {
      if (TRACK_NAME_PATTERNS[hand].test(trackNames[track])) {
        trackHands[track] = hand
        found[hand] = true
      }
    })
  })
  return found.left && found.right ? trackHands : null
}

export function handForNote (pitch, track, trackHands) {
  if (trackHands && trackHands[track]) return trackHands[track]
  return pitch < SPLIT_PITCH ? 'left' : 'right'
}

function clamp (value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Un curseur par main sur la liste des groupes de notes (bunches), et l'horloge.
 *
 * Le curseur d'une main est l'indice du prochain groupe contenant une note non jouée
 * de cette main, Infinity quand elle a fini. Le plus petit des deux curseurs est le
 * prochain instant du morceau.
 *
 * Chaque groupe est un tableau de notes [début ms, fin ms, hauteur, vélocité, main].
 */
export class HandCursors {

  constructor (bunchInfos, location = 0, mode = HAND_SYNC, clock = CLOCK) {
    this.mode = mode
    this.clock = clock
    this.lastIndex = bunchInfos.length - 1
    this.times = bunchInfos.map(bunch => bunch[0][0])
    this.lists = { left: [], right: [] }
    for (let i = 0; i < bunchInfos.length; i++) {
      const present = { left: false, right: false }
      for (let j = 0; j < bunchInfos[i].length; j++) present[bunchInfos[i][j][4]] = true
      HANDS.forEach(hand => present[hand] && this.lists[hand].push(i))
    }
    this.positions = { left: 0, right: 0 }
    this.lastPlayed = { left: -1, right: -1 }
    HANDS.forEach(hand => {
      while (this.positions[hand] < this.lists[hand].length && this.lists[hand][this.positions[hand]] < location) {
        this.positions[hand]++
      }
    })
    this.tempo = 1
    this.anchor = null // { real, score } : dernière pression qui a fait avancer le morceau
    this.intervals = [] // [{ real, score }] derniers intervalles retenus pour le tempo
  }

  cursor (hand) {
    const position = this.positions[hand]
    return position < this.lists[hand].length ? this.lists[hand][position] : Infinity
  }

  // Prochain groupe non entièrement joué, Infinity quand les deux mains ont fini
  next () {
    return Math.min(this.cursor('left'), this.cursor('right'))
  }

  /**
   * Le morceau est fini quand les deux mains ont fini, ou, en mode 'clock', dès qu'une main
   * a joué le dernier groupe : l'autre main peut encore jouer sa part de ce dernier accord.
   */
  ended () {
    if (this.next() === Infinity) return true
    return this.mode !== 'wait' && (this.lastPlayed.left === this.lastIndex || this.lastPlayed.right === this.lastIndex)
  }

  // Heure réelle attendue d'un groupe, d'après l'ancre et le tempo
  due (bunch) {
    return this.anchor.real + (this.times[bunch] - this.anchor.score) * this.tempo
  }

  earlyTolerance (bunch) {
    const gap = Math.abs(this.times[bunch] - this.anchor.score) * this.tempo
    return clamp(this.clock.earlyRatio * gap, this.clock.earlyMinMs, this.clock.earlyMaxMs)
  }

  /**
   * Pression d'une main ('left' | 'right') ou des deux (null : souris, toucher, fantôme)
   * à l'instant réel `now` (ms). Retourne :
   *   { played: [{ hand, bunch }], missed: { left: [bunch], right: [bunch] }, refused: null | motif, detail }
   * Les groupes manqués sont retirés des curseurs ; c'est à l'appelant de les afficher.
   */
  press (hand, now) {
    const result = { played: [], missed: { left: [], right: [] }, refused: null, detail: null }
    if (!hand) return this.pressAll(now, result)
    if (this.cursor(hand) === Infinity) return this.refuse(result, 'main terminée')
    if (this.mode === 'wait') {
      if (this.cursor(otherHand(hand)) < this.cursor(hand)) return this.refuse(result, 'attente : l\'autre main a une note avant')
      this.play(hand, now, result)
      return result
    }

    // L'horloge démarre à la première pression, sur le premier groupe à jouer
    if (!this.anchor) this.anchor = { real: now, score: this.times[this.next()] }
    // Une main joue toujours sa prochaine note : l'horloge seule ne lui fait jamais sauter
    // ses propres notes, sinon une pause (point d'orgue) ferait bondir le morceau. Seule
    // l'autre main, en avançant réellement, peut lui faire manquer des notes (ci-dessous).
    const bunch = this.cursor(hand)

    const due = this.due(bunch)
    const tolerance = this.earlyTolerance(bunch)
    if (now < due - tolerance) {
      return this.refuse(result, 'trop tôt', { bunch, due: Math.round(due), early: Math.round(due - now), tolerance: Math.round(tolerance) })
    }

    // Notes de l'autre main avant ce groupe : manquées si déjà en retard, conservées si elles
    // font quasiment partie du même accord ; une note pas encore due interdit de la sauter.
    const other = otherHand(hand)
    const otherMissed = []
    for (let p = this.positions[other]; p < this.lists[other].length; p++) {
      const c = this.lists[other][p]
      if (c >= bunch) break
      if ((this.times[bunch] - this.times[c]) * this.tempo <= this.clock.lateMs) break
      if (now > this.due(c) + this.clock.lateMs) {
        otherMissed.push(c)
      } else {
        return this.refuse(result, 'trop tôt : l\'autre main a une note avant, pas encore due',
          { bunch, otherBunch: c, otherDue: Math.round(this.due(c)), due: Math.round(due) })
      }
    }

    this.positions[other] += otherMissed.length
    result.missed[other] = otherMissed
    this.play(hand, now, result)
    return result
  }

  pressAll (now, result) {
    const next = this.next()
    if (next === Infinity) return this.refuse(result, 'morceau fini')
    if (!this.anchor) this.anchor = { real: now, score: this.times[next] }
    HANDS.filter(h => this.cursor(h) === next).forEach(h => this.play(h, now, result))
    return result
  }

  refuse (result, reason, detail = null) {
    result.refused = reason
    result.detail = detail
    return result
  }

  // Joue le groupe courant de la main et met l'horloge à jour
  play (hand, now, result) {
    const bunch = this.cursor(hand)
    this.positions[hand]++
    this.lastPlayed[hand] = bunch
    result.played.push({ hand, bunch })
    if (!this.anchor) this.anchor = { real: now, score: this.times[bunch] }
    const score = this.times[bunch] - this.anchor.score
    if (score <= 0) return // la main en retard rattrape un groupe déjà atteint : l'horloge ne bouge pas
    const real = now - this.anchor.real
    const ratio = real / score
    const factor = this.clock.outlierFactor
    if (ratio >= this.tempo / factor && ratio <= this.tempo * factor) {
      this.intervals.push({ real, score })
      if (this.intervals.length > this.clock.tempoWindow) this.intervals.shift()
      this.tempo = this.estimateTempo()
    }
    this.anchor = { real: now, score: this.times[bunch] }
  }

  // Rapport des sommes sur la fenêtre ; tant qu'elle n'est pas pleine, les intervalles
  // manquants comptent au tempo de la partition (k = 1, une seconde chacun).
  estimateTempo () {
    let real = 0
    let score = 0
    this.intervals.forEach(i => { real += i.real; score += i.score })
    const missing = this.clock.tempoWindow - this.intervals.length
    real += missing * 1000
    score += missing * 1000
    return clamp(real / score, this.clock.tempoMin, this.clock.tempoMax)
  }

  clockState () {
    return {
      tempo: Math.round(this.tempo * 1000) / 1000,
      anchor: this.anchor && { real: Math.round(this.anchor.real), score: Math.round(this.anchor.score) },
      intervals: this.intervals.map(i => [Math.round(i.real), Math.round(i.score)])
    }
  }

}
