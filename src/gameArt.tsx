import { useEffect, useState } from 'react'
import { callable } from '@decky/api'
import type { AgentResult } from './shared'

/**
 * A game's picture for the Games page: Steam's own library art when Steam knows the app id, else the cover the
 * SaveLocker server holds (relayed and cached by the agent, fetched through the backend because this page cannot
 * call the agent), else a letter tile. Each step is tried only when the one before it fails to load, so a game
 * Steam has never heard of costs one failed image request, not a blank row.
 *
 * Whether Steam serves a given app id's art at the address below, for a non-Steam shortcut in particular, has not
 * been checked on a Deck. The fall-through is what makes that safe.
 */

const fetchArt = callable<[string, string, number], AgentResult<string>>('game_art')

// Page redraws and list/grid switches remount rows; an image fetched once should not be fetched again.
const serverArt = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()

function loadServerArt(gameId: string, kind: 'grid' | 'icon', width: number): Promise<string | null> {
  const key = `${gameId}:${kind}:${width}`
  if (serverArt.has(key)) return Promise.resolve(serverArt.get(key) ?? null)
  const hit = pending.get(key)
  if (hit) return hit
  // Only a picture or the agent's 404 (the server has none) is remembered: a stopped agent or a timeout is tried
  // again on the next mount instead of leaving a letter tile for the rest of the session.
  const p = fetchArt(gameId, kind, width)
    .then((r) => {
      const v = r.ok ? r.data : null
      if (r.ok || r.reason === 'http-404') serverArt.set(key, v)
      return v
    })
    .catch(() => null)
    .finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}

const steamArt = (appId: number): string => `https://steamloopback.host/assets/${appId}_library_600x900.jpg`

export function GameArt({ game, kind, width, height }: {
  game: { gameId: string; name: string; steamAppId: number | null }
  kind: 'grid' | 'icon'
  width: number
  height: number
}) {
  // 0 = Steam's art, 1 = the server's, 2 = the letter tile.
  const [stage, setStage] = useState<0 | 1 | 2>(game.steamAppId ? 0 : 1)
  const [server, setServer] = useState<string | null>(null)

  useEffect(() => {
    if (stage !== 1) return
    let alive = true
    // The server's widths are a fixed list; 96 covers an icon and 256 a poster at this page's sizes.
    void loadServerArt(game.gameId, kind, kind === 'icon' ? 96 : 256).then((src) => {
      if (!alive) return
      if (src) setServer(src)
      else setStage(2)
    })
    return () => { alive = false }
  }, [stage, game.gameId, kind])

  // Icon (a fixed 40x40 beside a list row's text) keeps its pixel size. Grid sizes itself off the
  // CSS grid column instead — a fixed pixel width here left the art off the actual column width
  // whenever the page wasn't exactly 5 * (120px + gap) wide, which is what made Grid look broken.
  // width/height remain the letter tile's font-size hint (close enough to the real rendered size).
  const box = kind === 'icon'
    ? {
        width: `${width}px`, height: `${height}px`, borderRadius: '6px',
        flexShrink: 0, overflow: 'hidden', background: '#2a2f35',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      } as const
    : {
        width: '100%', aspectRatio: `${width} / ${height}`, borderRadius: '4px',
        overflow: 'hidden', background: '#2a2f35',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      } as const

  if (stage === 0 && game.steamAppId) {
    return (
      <div style={box}>
        <img src={steamArt(game.steamAppId)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setStage(1)} />
      </div>
    )
  }
  if (stage === 1 && server) {
    return (
      <div style={box}>
        <img src={server} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setStage(2)} />
      </div>
    )
  }
  return (
    <div style={{ ...box, fontWeight: 700, fontSize: `${Math.round(Math.min(width, height) * 0.45)}px`, opacity: 0.8 }}>
      {game.name.trim().charAt(0).toUpperCase() || '?'}
    </div>
  )
}
