### Fixed
- In the Android app, a PC's QR code scanned while the app shows your account's PCs now opens that
  PC, instead of leaving the list of PCs on screen. A PC's link written with the default port
  (`https://app.ovis.sh:443/...`) keeps its pairing offer when the app opens it.
- A PC's own page, on a signed-in device that the PC still has to approve, now offers to join that
  PC right there, instead of falling back to the list of PCs. After Ask to join it shows this
  device's number and says to press Approve on the PC's Ovis screen when it shows the same number
  (or run `ovis pair --approve`), then opens the PC once it is approved. A refusal or a request that
  ran out is said on the same screen.
