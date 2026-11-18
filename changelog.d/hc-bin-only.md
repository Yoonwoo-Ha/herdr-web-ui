### Changed
- With `OVIS_HC_BIN` set, Ovis runs only that herdr-core: when it does not answer, the server says
  so and stops instead of running another hc it finds.
- The desktop app's own herdr-core now gets 10 seconds instead of 3 to answer as the server starts.
  When it still does not answer, Ovis looks for another hc in the usual places as before, and says
  so: the server's log names both.
