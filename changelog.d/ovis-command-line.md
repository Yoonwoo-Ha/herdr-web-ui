### Changed
- The `ovis` command speaks like the coding-agent CLIs: `ovis login` adds the PC to your account (and
  opens its sign-in page in the browser on a desktop), `ovis logout` takes it out again after a typed
  yes, `ovis approve` answers the devices waiting to pair and `ovis pair --relay` shows the relay's
  code. `ovis status` also names the account and the relay. The old names (`add`, `link`,
  `link --code`, `pair --approve`) keep working.
- Plain `ovis` at a terminal opens the terminal screen where it can run, else prints the help;
  in a script it is still `ovis status`.
- `ovis login` is laid out as `codex login` is: 1/2 Sign in (the browser opens on a desktop; over SSH
  or with `--no-browser`, the address and code to type), 2/2 Let this PC in, and how to check or undo it.
- `ovis logout` says plainly that it cuts off every device of the PC, code-paired ones too, and takes
  the PC off the account's list of PCs with the PC's own proof.
- On Windows, the installer puts an `ovis` command on your PATH.

### Fixed
- `ovis <command> --help` only prints the command's help: `ovis stop --help` no longer stops Ovis,
  and a flag a command does not take (`ovis login --aprove`) is refused instead of ignored.
- `ovis --version` prints the version of the Ovis that runs.
