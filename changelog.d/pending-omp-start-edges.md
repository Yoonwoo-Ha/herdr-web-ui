### Fixed
- A chat message sent while a new workspace's agent is still starting is no longer queued after its
  page left the pane and came back while it waited, nor once it waited past the 45-second send
  deadline, and a message the queue already sent or discarded is not queued or typed again when its
  request arrives a second time.
- A queued message whose paste would reach the terminal after the send deadline now types nothing
  and says it was not sent.
