### Fixed
- A chat message sent while a new workspace's first message still waits for its agent to start is
  refused, not queued, when its page left the pane and came back before the message was taken up.
  It used to be queued and sent on its own later.
- A first message that nobody will send on its own is shown as held from the start. Other pages
  attached to its pane used to see it as queued for a moment first.
