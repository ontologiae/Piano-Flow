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

/**
 * Un curseur par main sur la liste des groupes de notes (bunches).
 *
 * Le curseur d'une main est l'indice du prochain groupe contenant une note non jouée
 * de cette main, Infinity quand elle a fini. Une main ne peut jouer son groupe que si
 * l'autre n'a aucune note non jouée avant lui : la main en avance attend l'autre.
 * Le plus petit des deux curseurs est le prochain instant du morceau.
 *
 * Chaque groupe est un tableau de notes dont l'élément d'indice 4 est la main.
 */
export class HandCursors {

  constructor (bunchInfos, location = 0) {
    this.lists = { left: [], right: [] }
    for (let i = 0; i < bunchInfos.length; i++) {
      const present = { left: false, right: false }
      for (let j = 0; j < bunchInfos[i].length; j++) present[bunchInfos[i][j][4]] = true
      HANDS.forEach(hand => present[hand] && this.lists[hand].push(i))
    }
    this.positions = { left: 0, right: 0 }
    HANDS.forEach(hand => {
      while (this.positions[hand] < this.lists[hand].length && this.lists[hand][this.positions[hand]] < location) {
        this.positions[hand]++
      }
    })
  }

  // La main a-t-elle au moins une note dans le morceau ?
  hasNotes (hand) {
    return this.lists[hand].length > 0
  }

  cursor (hand) {
    const position = this.positions[hand]
    return position < this.lists[hand].length ? this.lists[hand][position] : Infinity
  }

  // Prochain groupe non entièrement joué, Infinity quand le morceau est fini
  next () {
    return Math.min(this.cursor('left'), this.cursor('right'))
  }

  ended () {
    return this.next() === Infinity
  }

  canAdvance (hand) {
    const mine = this.cursor(hand)
    return mine !== Infinity && this.cursor(otherHand(hand)) >= mine
  }

  /**
   * Mains qui jouent à cette pression. Avec une main : elle seule, si elle n'attend pas.
   * Sans main (souris, toucher, fantôme) : toutes celles qui sont sur le prochain groupe.
   */
  handsToPlay (hand) {
    if (hand) return this.canAdvance(hand) ? [hand] : []
    const next = this.next()
    return next === Infinity ? [] : HANDS.filter(h => this.cursor(h) === next)
  }

  advance (hand) {
    this.positions[hand]++
  }

}
