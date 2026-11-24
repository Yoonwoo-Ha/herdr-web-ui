### Fixed
- The app reconnects to a PC through the relay at once when it comes back from the background,
  instead of waiting a second or more for a connection attempt that was frozen in the background,
  and that attempt no longer moves the connection to the other relay. The app's own connection
  then reopens as soon as the relay is back, rather than after its retry wait.
