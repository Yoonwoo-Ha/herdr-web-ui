### Fixed
- On a herdr-core core, an agent started from an hc template (which hc runs as `sh -c "<command>"`)
  gets its chat instead of only its terminal screen: Ovis reads the program the shell runs below it.
