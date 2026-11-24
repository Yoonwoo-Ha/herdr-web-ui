### Fixed
- A PC added to your account over SSH (Add PC with "Add it to my account") now turns its Ovis relay
  on and waits for it to come online, as `ovis add` does, so your phone can open it. The dialog says
  "Added" only once its relay is online; otherwise it says the PC is in your account but its relay
  is not online yet, and to run `ovis status` there. Adding a PC that is already in your account
  again leaves a relay you turned off there off, and says so.
- When the account service refuses Add PC's account add because your sign-in is too old, the dialog
  now offers Sign in again in place, and the add goes on by itself without typing the host again.
- A PC that is only listed in your account (an add that stopped at the sign-in) no longer shows as
  "In your account" in Settings → Devices and PCs or in Add a connection's relay tab: Settings says
  "Waiting to be added", and the relay tab keeps Add on its row, which adds the PC already saved here
  instead of saving it a second time.
- The "Machine offline" messages on a phone now name a relay turned off on the PC as a cause, next to
  the PC being off.
