/**
 * The privacy notice for new players (g2-6f; decision #62 Q6: everywhere, not
 * only on CrazyGames, whose rule it is: "the game should add a Terms &
 * Conditions and/or Privacy Policy notice to new players. We recommend to
 * make this a simple notice rather than a pop-up", requirements/technical,
 * read 2026-11-13). One line under READY, linking the privacy page, until
 * this browser's first run starts.
 *
 * "New" is this browser: no account token stored (a player who has played
 * here has one) and no record of the notice having been shown through to a
 * run (`NOTICE_KEY`, set when READY is pressed). Storage that throws counts
 * as new: the notice shows rather than not.
 *
 * Pixi-free and `window`-free.
 */
export const NOTICE_KEY = 'plunderland_privacy_seen'

export const NOTICE_TEXT = 'By playing you accept our'
export const NOTICE_LINK = 'Privacy Policy'

export interface NoticeStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function read (storage: NoticeStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Whether the lobby shows the notice: no token (`tokenKey`) and not seen through to a run. */
export function privacyNoticeShown (storage: NoticeStorage | undefined, tokenKey: string): boolean {
  return (read(storage, tokenKey) ?? '') === '' && read(storage, NOTICE_KEY) === null
}

/** READY was pressed with the notice shown: it is not shown again on this browser. */
export function markPrivacyNoticeSeen (storage: NoticeStorage | undefined): void {
  try {
    storage?.setItem(NOTICE_KEY, '1')
  } catch {
    // Not remembered: shown again next lobby, until the run's token is stored.
  }
}
