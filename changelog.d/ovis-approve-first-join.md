### Fixed
- A PC with no screen can now let in a phone that asks for six digits when it first opens the PC after
  `ovis add`. Only the PC itself may accept that request, and `ovis approve` used to skip it and say no
  device was waiting. Now `ovis approve` names the device, its account and when it asked, and lets it
  in once the six digits it shows are typed. `ovis add` at a terminal goes on after "Added." and asks
  for those digits itself, ending as soon as the phone opens the PC without them; without a terminal it
  says to run `ovis approve`.
