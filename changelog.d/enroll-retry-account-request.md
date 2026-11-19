### Fixed
- Adding a PC to your account no longer fails for good when the connection to the account service
  drops under one of its requests: the request goes again once the browser is back online, or after
  2 and then 8 seconds, at most three times in all, and waits as long as a busy account service
  asks.
