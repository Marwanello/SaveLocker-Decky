/**
 * The two SteamClient members this plugin uses, declared locally.
 *
 * These are undocumented Valve internals reached through Steam's own JS context — the reason the
 * plugin exists, and the reason it is only ever an accelerator: when Steam changes them the plugin
 * breaks, and SaveLocker's copy-paste path has to still be there. Declaring only what we call keeps
 * that surface visible and small, rather than importing a wide ambient global.
 *
 * Signatures match SteamDeckHomebrew/decky-frontend-lib `globals/steam-client/App.ts`.
 */
interface SaveLockerAppDetails {
  /** Launch options for an installed Steam game. */
  strLaunchOptions?: string
  /** Launch options for a NON-Steam shortcut — the case SaveLocker exists for. */
  strShortcutLaunchOptions?: string
}

interface SaveLockerUnregisterable {
  unregister(): void
}

/**
 * One app's running state changing — the Gaming Mode launch/close signal, for the same reason
 * `RegisterForAppDetails` above is the launch-options signal: nothing this plugin's Python backend
 * can see fires here, only Steam's own JS context does. `bRunning` flips true near process start and
 * false once it has genuinely exited (unlike `RegisterForGameActionStart`, which only ever fires on
 * the way in) — the exit edge is what makes this the right hook for a post-exit push, since by then
 * there is no race left to reason about.
 */
interface SaveLockerAppLifetimeNotification {
  unAppID: number
  bRunning: boolean
}

/** The one `appStore` field this plugin reads: a Steam app's own display name, as the fallback
 * match when a game's Steam AppID has not been resolved agent-side (see `TrackedGame.alias`). */
interface SaveLockerAppOverview {
  display_name?: string
}

declare const SteamClient: {
  Apps: {
    SetAppLaunchOptions(appId: number, launchOptions: string): void
    RegisterForAppDetails(
      appId: number,
      callback: (data: SaveLockerAppDetails) => void,
    ): SaveLockerUnregisterable
  }
  GameSessions: {
    RegisterForAppLifetimeNotifications(
      callback: (data: SaveLockerAppLifetimeNotification) => void,
    ): SaveLockerUnregisterable
  }
}

declare const appStore: {
  GetAppOverviewByAppID(appId: number): SaveLockerAppOverview | null
}
