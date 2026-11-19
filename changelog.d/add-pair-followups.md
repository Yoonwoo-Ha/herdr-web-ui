### Fixed
- `pair` and `pair --approve` no longer wait forever when Ovis answers its health check and then
  stops answering: they give up after the time limit their later requests already had, and say so.
- `ovis add` prints why there is no code to type without the server route in front of it, and
  names GitHub or Google on its sign-in line only at the real account service.
