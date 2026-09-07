/**
 * The SteamClient members this plugin uses, declared locally.
 *
 * These are undocumented Valve internals reached through Steam's own JS context — the reason the
 * plugin exists, and the reason it is only ever an accelerator: when Steam changes them the plugin
 * breaks, and SaveLocker's copy-paste path has to still be there. Declaring only what we call keeps
 * that surface visible and small, rather than importing a wide ambient global.
 *
 * Signatures match SteamDeckHomebrew/decky-frontend-lib `globals/steam-client/App.ts`
 * (`node_modules/@decky/ui/src/globals/steam-client/App.ts` in this repo).
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
 * One app's running state changing — the Gaming Mode close signal (see `RegisterForGameActionStart`
 * below for the launch signal now used instead of this one on the way in). `bRunning` flips true near
 * process start and false once it has genuinely exited — the exit edge is what makes this the right
 * hook for a post-exit push, since by then there is no race left to reason about.
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
    /**
     * Fires the instant ANY app launch begins — `appId` here is a numeric string, unlike the `number`
     * everywhere else in this file, and `launchSource` is `ELaunchSource` (App.ts line ~1494),
     * reduced to `number` here since nothing in this plugin branches on its value, only forwards it
     * back into `RunGame`. Unlike `RegisterForAppLifetimeNotifications`'s `bRunning`, this fires
     * BEFORE the process exists — the same App-Action pipeline Steam's own Cloud sync blocks on
     * (`LaunchAppTask_t` includes a `SynchronizingCloud` step ahead of `CreatingProcess`), which is
     * why `CancelGameAction` below can still stop the launch when this callback runs.
     */
    RegisterForGameActionStart(
      callback: (gameActionId: number, appId: string, action: string, launchSource: number) => void,
    ): SaveLockerUnregisterable
    /** Stops an in-flight game action before it reaches `CreatingProcess` — only useful called
     * synchronously from `RegisterForGameActionStart`'s own callback, before any `await`. Undocumented
     * whether this can silently lose the race once the pipeline is far enough along, which is exactly
     * why `handleGameActionStart` re-checks `GetActiveGameActions` immediately after calling it rather
     * than assuming it worked. */
    CancelGameAction(gameActionId: number): void
    /** Re-triggers a launch this plugin itself cancelled. `launchOptions` appends to (not replaces)
     * the app's own configured options, so `''` is a no-op append — this plugin re-launches with
     * whatever the game was already going to run with. */
    RunGame(appId: string, launchOptions: string, param2: number, launchSource: number): void
    /** Confirms a `CancelGameAction` call actually took: if `gameActionId` is still present here
     * right after cancelling, the pipeline had already moved past a cancellable state and this plugin
     * should back off rather than risk launching a second copy of the game on top of the one Steam is
     * already starting. Absence here is NOT proof the cancel is why — the action can also be gone
     * because it already reached `CreatingProcess`, especially for a non-Steam-shortcut launch which
     * can skip almost every intermediate `LaunchAppTask_t` stage a Steam-store game passes through
     * first, leaving `CancelGameAction` too little of a window to land even called synchronously. See
     * `gamingSync.tsx`'s `blockedLaunches` for the fallback this uncertainty requires. */
    GetActiveGameActions(): Promise<{ nGameActionID: number }[]>
    /** Kills a running app's process (the Library UI's own "Stop"/"Force quit"). `param1`'s exact
     * meaning is undocumented — real Steam UI code passes a boolean here whose behavior visibly
     * differs (a graceful stop vs. an immediate one), and this plugin passes `true` for "immediate":
     * the whole point of calling this is a conflicted save that must not keep running, not a polite
     * request the game can ignore. Unverified on real hardware which value that actually is. */
    TerminateApp(appId: string, param1: boolean): void
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
