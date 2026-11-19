### Fixed
- A Markdown file's Preview draws reference-style links (`[text][label]` with `[label]: address`)
  as links, and leaves their definition lines out, as GitHub does. The Preview now reads Markdown
  the CommonMark way, so lists, headings and emphasis that span lines also read as on GitHub;
  chat messages are unchanged.
