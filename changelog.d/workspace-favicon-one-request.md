### Fixed
- Loading the page no longer sends about 33 requests per workspace folder to find its project icon:
  each folder is asked once (`GET /api/fs/favicon`), and a folder without an icon is an answer, not
  a 404. A reverse proxy with a rate limit no longer answers 429 to the burst, and the browser
  console no longer fills with red 404 lines on every load. A 429 is no longer remembered as "no
  icon" either: the folder is asked again when its row next appears.
