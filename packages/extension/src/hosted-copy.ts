// The sign-in, account and connection copy the popup, the options page and
// the overlay share (spec §4, §10) — one place, so the lexicon test reads
// every string and a copy pass edits them once.
export const HOSTED_COPY = {
  signedOutTitle: "Sign in to Onlay",
  signedOutBody: "Comment on and edit any page with the people you work with.",
  signIn: "Sign in",
  threadGone: "This thread isn't available to you anymore, so it was closed.",
  signInOpened: "Finish signing in on the tab that just opened.",
  signInFailed: "Couldn't start signing in. Try again.",
  signOut: "Sign out",
  signingOut: "Signing out…",
  // The extension's Sign out revokes only its own token; the browser's sign-in stays.
  extensionSignedOut:
    "The extension is signed out. If this browser is still signed in to the web app, Sign in uses that account.",
  // Followed by a link to the web app's account settings, whose words are these.
  extensionSwitchLead: "To switch accounts, ",
  extensionSwitchLink: "sign out there first",
  extensionSwitchTail: ".",
  upgradeTitle: "Update Onlay",
  upgradeBody: "This version of Onlay is out of date. Update the extension to keep going.",
  offlineSignedIn: "Can't reach the Onlay server. Reconnecting…",
  offlineSignedOut: "You're signed out. Sign in from the Onlay toolbar button.",
  noSpace: "You're not a member of any space.",
  accountTitle: "Account",
  accountSignedOut: "You're signed out.",
  accountWebSettings: "Manage your account and spaces",
  accountSpaces: "Spaces",
  guestRole: "guest",
  popupInboxEmpty: "Nothing needs you.",
  popupSettings: "Settings",
  updateAvailable: "A newer version of Onlay is out.",
  updateLink: "How to update",
} as const;
