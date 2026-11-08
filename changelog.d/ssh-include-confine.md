### Fixed
- On Linux with glibc, an Include wildcard in the ssh config (`Include conf.d/*/*`) is never read
  from outside the home folder, not even through a folder swapped for a link after it was checked;
  the hosts such a folder could change claim no PC. Elsewhere (macOS, Windows, Linux without glibc)
  a wildcard Include's folders are listed by path, which gives names only: a name from outside home
  can be listed and a file missed, so any host the files found that way name or set an option for,
  and any host after that Include, is listed without claiming a Tailscale PC. A wildcard looks at 1024 folder
  entries at most across the config.
- The SSH list keeps the files a wildcard matches in ssh's order, and claims nothing for a host that
  an Include of another user's home (`~user`) or a pattern it cannot match exactly (`[[:digit:]]`)
  could change.
- The SSH list keeps a row for each Tailscale PC it lists within its 200-row limit, so many config
  hosts (such as ones a skipped Include leaves undetermined) no longer push a PC off the list.
