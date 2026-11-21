import MIDI from './midi'
import root from './_root'
import { rgb2hex, blendAlpha } from './utils'
import { noteTexture } from './textures'
import ConductorSounder from './conductor-sounder'
import ConductorNoteVis from './conductor-note-vis'
import GhostPlayer from './ghost-player'
import DecayParticleManager from './decay-particle-manager'
import { HandCursors, handForKey, handForNote, otherHand, trackHandsFromNames, HAND_SYNC, CLOCK, SPLIT_PITCH, LEFT_HAND_KEYS, RIGHT_HAND_KEYS } from './hands'
import { log } from './journal'

export default class ConductorPerformer {

  constructor (isGhost, location = root.initLocation) {
    this.noteInfos = []
    this.bunchInfos = []
    this.ghostInfos = []
    this.firstVisibleBunchIndex = location
    this.nextTargetBunchIndex = location // firstVisibleBunchIndex is equal to nextTargetBunchIndex
    this.lastPlayedBunchIndex = Math.max(0, location - 1)
    this.handCursors = null // set once the bunches exist, see ready()
    this.isGhostMode = isGhost

    this.bunchPositions = []
    this.noteObjects = []

    this.pressedKeys = []
    this.noteTexture = noteTexture
    this.noteTexture.baseTexture.premultipliedAlpha = false
    this.camAtPixel = 0
    this.prevCamAtPixel = 0
    this.lastFrameTime = 0
    this.residual = 0
    this.particleManager = new DecayParticleManager()
    this.pressTrigger = false
    this.pieceEnded = false
    this.numTouched = 0
    this.touchedIds = []
    this.ready()
  }

  ready () {
    setTimeout(() => {
      this.colorTheme = this.generateColorTheme(root.theme)
      this.noteInfos = this.generateNoteInfos(MIDI.Player.data)
      this.bunchInfos = this.generateBunchInfos(this.noteInfos)
      this.handCursors = new HandCursors(this.bunchInfos, this.nextTargetBunchIndex)
      this.ghostInfos = this.generateGhostInfos(this.bunchInfos)
      this.render()

      this.ghostPlayer = new GhostPlayer(this.ghostOn.bind(this), this.ghostOff.bind(this))
      this.sounder = new ConductorSounder()
      this.sounder.setLocation(this.firstVisibleBunchIndex)

      this.logPiece()
      root.performerReady()
    }, 0)
  }

  // Score time (ms) of a bunch, null past the end
  bunchTime (index) {
    return index === Infinity || index == null || !this.bunchInfos[index] ? null : Math.round(this.bunchInfos[index][0][0])
  }

  handState () {
    const state = { present: this.lastPlayedBunchIndex, nextTarget: this.nextTargetBunchIndex }
    ;['left', 'right'].forEach(hand => {
      const cursor = this.handCursors.cursor(hand)
      state[hand] = { cursor: cursor === Infinity ? 'fin' : cursor, time: this.bunchTime(cursor) }
    })
    return state
  }

  logPiece () {
    const piece = root.piece || {}
    const count = { left: 0, right: 0 }
    this.noteInfos.forEach(n => count[n.hand]++)
    log('INFO', 'piece.ready', {
      name: piece.name,
      midiFile: piece.midiFile,
      mode: this.isGhostMode ? 'autoplay' : 'rhythm',
      handSync: HAND_SYNC,
      clock: CLOCK,
      attribution: this.trackHands ? 'pistes' : 'pivot ' + SPLIT_PITCH,
      trackNames: this.trackNames,
      trackHands: this.trackHands,
      location: this.nextTargetBunchIndex,
      bunches: this.bunchInfos.length,
      notes: this.noteInfos.length,
      notesPerHand: count,
      keys: { left: LEFT_HAND_KEYS.join(''), right: RIGHT_HAND_KEYS.join('') }
    })
    // Full map of the piece: [bunch, score time ms, hands, pitches per hand]
    log('INFO', 'piece.score', this.bunchInfos.map((bunch, i) => {
      const pitches = { G: [], D: [] }
      bunch.forEach(n => pitches[n[4] === 'left' ? 'G' : 'D'].push(n[2]))
      return [i, Math.round(bunch[0][0]), (pitches.G.length ? 'G' : '') + (pitches.D.length ? 'D' : ''), pitches.G, pitches.D]
    }))
  }

  render () {
    this.bunchPositions = this.generateBunchPositions(this.bunchInfos)
    this.noteObjects = this.generateNoteObjects(this.bunchInfos)
  }

  generateColorTheme (theme) {
    if (Array.isArray(theme)) {
      // TODO: More flexible theme
      return [15641186, 11502404, 8281903, 5783073, 3613208].reverse()
    }
    return [
      rgb2hex(theme.brand),
      blendAlpha(theme.accent, 0.6, theme.brand),
      rgb2hex(theme.accent),
      blendAlpha(theme.accent, 0.7, theme.bg),
      blendAlpha(theme.accent, 0.4, theme.bg)
    ].reverse()
  }

  generateNoteInfos (midiData) {
    let currentTime = 0
    const noteInfos = []
    const noteTimes = []
    const noteVelocities = []
    const trackHands = this.generateTrackHands(midiData)
    this.trackHands = trackHands

    for (let i = 0, len = midiData.length; i < len; i++) {
      const midi = midiData[i]
      const event = midi[0].event
      const track = midi[0].track
      const interval = midi[1]
      const { subtype, noteNumber, channel, velocity } = event

      currentTime += interval

      // In General MIDI, channel 10 is reserved for percussion instruments only.
      // It doesn't make any sense to convert it into piano notes. So just skip it.
      if (channel === 9) continue

      // Notes are paired per track: two hands on two tracks may sound the same pitch together
      const noteKey = track * 128 + noteNumber

      if (subtype === 'noteOn') {
        // if note is on, record its start time & velocity
        noteTimes[noteKey] = currentTime
        noteVelocities[noteKey] = velocity
      } else if (subtype === 'noteOff') {
        // if note if off, calculate its duration and build the model
        const startTime = noteTimes[noteKey]
        const duration = currentTime - startTime
        const velocity = noteVelocities[noteKey]
        noteInfos.push({
          notePitch: noteNumber,
          duration: duration,
          startTime: startTime,
          endTime: currentTime,
          velocity: velocity,
          hand: handForNote(noteNumber, track, trackHands)
        })
      }
    }

    noteInfos.sort((a, b) => a.startTime - b.startTime)
    return noteInfos
  }

  // Track number -> hand, from track names like "Piano left" / "Piano right"; null when the file has no such pair
  generateTrackHands (midiData) {
    const trackNames = {}
    for (let i = 0; i < midiData.length; i++) {
      const { event, track } = midiData[i][0]
      if (event.subtype === 'trackName') trackNames[track] = event.text
    }
    this.trackNames = trackNames
    return trackHandsFromNames(trackNames)
  }

  generateBunchInfos (noteInfos) {
    const bunchInfos = []
    let bunch = []
    let currentStartTime = noteInfos[0].startTime

    // TODO: Combine notes more flexible
    for (let i = 0; i < noteInfos.length; i++) {
      const { startTime, endTime, notePitch, velocity, hand } = noteInfos[i]
      if (Math.abs(startTime - currentStartTime) > (1000 / 12) && velocity > 16) { // startTime !== currentStartTime
        currentStartTime = startTime
        bunchInfos.push(bunch)
        bunch = []
      }
      bunch.push([startTime, endTime, notePitch, velocity, hand])
    }
    bunchInfos.push(bunch) // Push the last bunch
    return bunchInfos
  }

  generateGhostInfos (bunchInfos) {
    const ghostInfos = []

    for (let i = 0; i < bunchInfos.length; i++) {
      const [startTime, endTime] = bunchInfos[i][0]
      ghostInfos.push([startTime, endTime - startTime])
    }

    return ghostInfos
  }

  generateBunchPositions (bunchInfos) {
    const bunchPositions = []
    let spacingFactor = (0.08 * bunchInfos.length * root.width) / (bunchInfos[bunchInfos.length - 1][0][0] - bunchInfos[0][0][0])
    spacingFactor *= root.spacingMultiplier
    spacingFactor = Math.max(spacingFactor, 0.3) // Minimum
    let initTime = bunchInfos[0][0][0]
    // TODO: Limit min and max distance
    for (let i = 0; i < bunchInfos.length; i++) {
      const bunch = bunchInfos[i]
      let nextTime = bunch[0][0]
      nextTime -= initTime
      bunchPositions.push(nextTime * spacingFactor)
    }
    return bunchPositions
  }

  generateNoteObjects (bunchInfos) {
    const noteObjects = []
    let minPitch = 999999
    let maxPitch = -999999
    for (let i = 0; i < bunchInfos.length; i++) {
      const bunch = bunchInfos[i]
      for (let j = 0; j < bunch.length; j++) {
        const note = bunch[j]
        note[2] < minPitch && (minPitch = note[2])
        note[2] > maxPitch && (maxPitch = note[2])
      }
    }
    let index = 0
    for (let i = 0; i < bunchInfos.length; i++) {
      const bunch = bunchInfos[i]
      const noteVisBunch = []
      noteObjects.push(noteVisBunch)
      for (let j = 0; j < bunch.length; j++) {
        const note = bunch[j]
        let positionY = (1 - (note[2] - minPitch) / (maxPitch - minPitch)) * root.height
        positionY *= 0.70
        positionY += 0.1 * root.height
        // TODO: Limit min and max size
        let size = note[3] / 127 * 0.96
        size = Math.max(size, 0.25) // Minimum
        size = Math.min(size, 0.6) // Maximum
        // TODO: Use flow to replace circle
        const noteVis = new ConductorNoteVis(this.bunchPositions[index], positionY, size, note)
        noteVis.setScale(0.003125 * root.height * (128 / this.noteTexture.width) * 0.4 * root.sizeMultiplier)
        noteVisBunch.push(noteVis)
      }
      // Set tint
      const bunchSortedByPitch = noteVisBunch.slice(0).sort((a, b) => a.notePitch - b.notePitch)
      switch (bunchSortedByPitch.length) {
        case 1:
          bunchSortedByPitch[0].setTint(this.colorTheme[4])
          break
        case 2:
          bunchSortedByPitch[0].setTint(this.colorTheme[1])
          bunchSortedByPitch[1].setTint(this.colorTheme[4])
          break
        case 3:
          bunchSortedByPitch[0].setTint(this.colorTheme[1])
          bunchSortedByPitch[1].setTint(this.colorTheme[3])
          bunchSortedByPitch[2].setTint(this.colorTheme[4])
          break
        case 4:
          bunchSortedByPitch[0].setTint(this.colorTheme[1])
          bunchSortedByPitch[1].setTint(this.colorTheme[2])
          bunchSortedByPitch[2].setTint(this.colorTheme[3])
          bunchSortedByPitch[3].setTint(this.colorTheme[4])
          break
        default:
          for (let i = 0; i < bunchSortedByPitch.length; i++) {
            bunchSortedByPitch[i].setTint(this.colorTheme[4 - Math.min(bunchSortedByPitch.length - 1 - i, this.colorTheme.length - 1)])
          }
      }
      index++
    }

    return noteObjects
  }

  redraw (timestamp) {
    if (this.lastFrameTime === 0) return (this.lastFrameTime = timestamp)

    let deltaTime = timestamp - this.lastFrameTime
    this.lastFrameTime = timestamp
    deltaTime += this.residual
    this.residual = deltaTime % 1
    deltaTime -= this.residual
    deltaTime > 500 && (deltaTime = 16)

    for (let i = this.firstVisibleBunchIndex; i < this.noteObjects.length; i++) {
      const bunch = this.noteObjects[i]
      let isBunchOnStage = false
      let outOfStage = false
      for (let j = 0; j < bunch.length; j++) {
        const note = bunch[j]
        const noteX = this.warpX(note.curX, note.curY)
        const noteY = this.warpY(note.curX, note.curY)
        if (noteX >= 0 && noteX <= 1.2 * root.width) {
          isBunchOnStage = true
          note.setPosition(noteX, noteY)
          !note.isOnStage && note.addSelfToStage(root.stage)
          note.advance(deltaTime)
          if (!note.isPlayed && !note.isMissed && this.pressTrigger) {
            const distanceRatio = 1 - (this.bunchPositions[i] - this.bunchPositions[this.lastPlayedBunchIndex]) / root.width
            note.pressTrigger(distanceRatio, this.lastPlayedTotalVel)
          }
        }
        if (noteX < 0 && note.isOnStage) note.removeSelfFromStage(root.stage)
        if (noteX > root.width) outOfStage = true
      }
      if (outOfStage) break // Stage locking
      if (!isBunchOnStage) {
        for (let i = 0; i < this.noteObjects[this.firstVisibleBunchIndex].length; i++) {
          let j = this.noteObjects[this.firstVisibleBunchIndex][i]
          j.isOnStage && j.removeSelfFromStage(root.stage)
        }
        this.firstVisibleBunchIndex++
      }
    }

    this.prevCamAtPixel = this.camAtPixel
    for (let i = 0; i < Math.floor(deltaTime); i++) {
      this.camAtPixel += 0.00228 * (this.bunchPositions[this.nextTargetBunchIndex] - this.camAtPixel)
    }
    this.particleManager.advance(deltaTime, this.camAtPixel - this.prevCamAtPixel)
    this.pressTrigger = false
    if (this.isGhostMode && !this.pieceEnded) this.ghostPlayer.advance(deltaTime)
  }

  switchMode (mode) {
    this.isGhostMode = mode === 'autoplay'
    if (this.isGhostMode) this.ghostPlayer.ready()
  }

  // Sounds and triggers the next notes, and returns whether anything was played.
  // hand: 'left' | 'right' plays that hand's next notes (see HAND_SYNC in ./hands for how the hands sync);
  // no hand (mouse, touch, ghost) plays every note of the next bunch, both hands together.
  // Once the piece has ended, the other hand may still play its share of the last bunch.
  // now: real time of the press in ms (performance.now() by default)
  pressAdvance (hand, power, input, now = window.performance.now()) {
    const before = this.handState()
    const result = this.handCursors.press(hand, now)
    if (result.refused) {
      log('INFO', 'press.refused', {
        input, hand, now: Math.round(now), reason: result.refused, detail: result.detail, before, clock: this.handCursors.clockState()
      })
      return false
    }

    const missedLog = []
    ;['left', 'right'].forEach(h => {
      const missed = result.missed[h]
      if (!missed.length) return
      const missedNotes = this.missNotes(h, missed)
      missedLog.push({
        hand: h,
        bunchCount: missed.length,
        noteCount: missedNotes,
        from: { bunch: missed[0], time: this.bunchTime(missed[0]) },
        to: { bunch: missed[missed.length - 1], time: this.bunchTime(missed[missed.length - 1]) },
        bunches: missed
      })
    })

    const notes = []
    const played = []
    result.played.forEach(({ hand: h, bunch: bunchIndex }) => {
      const bunch = this.noteObjects[bunchIndex]
      const pitches = []
      for (let i = 0; i < bunch.length; i++) {
        if (bunch[i].hand === h) {
          notes.push(bunch[i])
          pitches.push(bunch[i].notePitch)
        }
      }
      played.push({ hand: h, bunch: bunchIndex, time: this.bunchTime(bunchIndex), pitches })
      // A late hand may still play an earlier bunch: the present is the furthest bunch reached
      this.lastPlayedBunchIndex = Math.max(this.lastPlayedBunchIndex, bunchIndex)
    })

    this.lastPlayedTotalVel = this.sounder.press(power, notes)
    for (let i = 0; i < notes.length; i++) {
      notes[i].playTrigger()
    }
    this.pressTrigger = true

    const wasEnded = this.pieceEnded
    if (!this.pieceEnded) {
      if (this.handCursors.ended()) {
        this.nextTargetBunchIndex = this.noteObjects.length - 1
        this.pieceEnded = true
      } else {
        this.nextTargetBunchIndex = this.handCursors.next()
      }
    }
    log(missedLog.length ? 'WARN' : 'INFO', 'press', {
      input,
      hand,
      now: Math.round(now),
      played,
      missed: missedLog,
      before,
      after: this.handState(),
      clock: this.handCursors.clockState(),
      pieceEnded: this.pieceEnded,
      afterEnd: wasEnded
    })
    if (!wasEnded && this.pieceEnded && this.isGhostMode) root.endPiece()
    return true
  }

  // The hand's notes in these bunches were not played in time: they stay silent and fade out.
  // Returns the number of notes missed.
  missNotes (hand, bunchIndexes) {
    let count = 0
    for (let b = 0; b < bunchIndexes.length; b++) {
      const bunch = this.noteObjects[bunchIndexes[b]]
      for (let i = 0; i < bunch.length; i++) {
        if (bunch[i].hand === hand) {
          bunch[i].missTrigger()
          count++
        }
      }
    }
    return count
  }

  // Hand of a pressed key; null when the key belongs to neither zone.
  // A hand with nothing left to play hands its zone over to the other hand: without a clock,
  // nothing else would ever make the other hand's remaining notes playable or missed.
  handForKey (event) {
    const hand = handForKey(event)
    if (!hand) return null
    const other = otherHand(hand)
    const done = this.handCursors.cursor(hand) === Infinity
    return done && this.handCursors.cursor(other) !== Infinity ? other : hand
  }

  keyInput (event) {
    return { source: 'key', key: event.key, keyCode: event.keyCode, repeat: !!event.repeat, zone: handForKey(event), pressedKeys: this.pressedKeys.slice(0) }
  }

  handleKeyPress (event) {
    const input = this.keyInput(event)
    if (this.isGhostMode) {
      event.preventDefault()
      log('INFO', 'key.ghostSpooked', input)
      return root.ghostWasSpooked()
    }
    const hand = this.handForKey(event)
    if (!hand) return log('INFO', 'key.ignored', input) // Outside both zones: not a piano key
    if (hand !== input.zone) input.transferredTo = hand
    event.preventDefault()
    // A held key plays once, even if the OS repeats it after the other hand let it through
    if (event.repeat && !root.repeatOnHold) return log('DEBUG', 'key.repeatIgnored', input)
    if (this.pressedKeys.indexOf(event.keyCode) === -1) {
      // A press that waits for the other hand plays nothing and is not recorded
      if (this.pressAdvance(hand, 0.5, input)) {
        !root.repeatOnHold && this.pressedKeys.push(event.keyCode)
      }
    } else {
      log('DEBUG', 'key.alreadyDown', input)
    }
  }

  handleKeyDepress (event) {
    const input = this.keyInput(event)
    if (this.isGhostMode) return event.preventDefault()
    if (!this.handForKey(event)) return log('DEBUG', 'key.up.ignored', input)
    event.preventDefault()
    const wasDown = this.pressedKeys.indexOf(event.keyCode) !== -1
    if (wasDown) {
      this.pressedKeys.splice(this.pressedKeys.indexOf(event.keyCode), 1)
      this.sounder.depress()
    }
    log('DEBUG', 'key.up', { input, wasDown, pieceEnded: this.pieceEnded })
    if (this.pieceEnded && !this.pressedKeys.length) {
      root.endPiece()
    }
  }

  handleTouch (event) {
    if (this.isGhostMode) return root.ghostWasSpooked()
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i]
      if (this.touchedIds.indexOf(touch.identifier) === -1) {
        !root.repeatOnHold && this.touchedIds.push(touch.identifier)
        const power = (root.height - touch.clientY) / root.height
        this.pressAdvance(null, power, { source: 'touch', id: touch.identifier, y: touch.clientY })
        this.numTouched++
      }
    }
  }

  handleUntouch (event) {
    if (!this.isGhostMode) {
      for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i]
        const index = this.touchedIds.indexOf(touch.identifier)
        if (index === -1) {
          this.touchedIds.splice(index, 1)
          this.numTouched--
          if (this.numTouched < 0) this.numTouched = 0
          this.sounder.depress()
        }
      }
      if (this.pieceEnded && this.numTouched === 0) root.endPiece()
    }
  }

  handleMouseDown (event) {
    event.preventDefault()
    if (event.which === 1) {
      if (this.isGhostMode) return root.ghostWasSpooked()
      const power = (root.height - event.clientY) / root.height
      this.pressAdvance(null, power, { source: 'mouse', y: event.clientY })
    }
  }

  handleMouseUp (event) {
    event.preventDefault()
    if (event.which === 1 && !this.isGhostMode) {
      if (this.pieceEnded) root.endPiece()
      this.sounder.depress()
    }
  }

  warpX (x) {
    let distance = x - this.camAtPixel
    let distanceRatio = distance / root.width
    let delta = -1.5
    let count = 1 - Math.exp(distanceRatio * delta)
    let total = 1 - Math.exp(delta)
    let widthShift = 0.25 * root.width
    return widthShift + root.width * (count / total)
  }

  warpY (x, y) {
    return y
  }

  ghostOn () {
    this.pressAdvance(null, 0.5, { source: 'ghost' })
  }

  ghostOff () {
    this.sounder.depress()
  }

}
