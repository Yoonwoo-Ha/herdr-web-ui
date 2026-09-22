# Project artwork

`icon-source.png` is the original artwork supplied by the project owner: a ram,
terminal prompt, browser window and pointer. Exports preserve the artwork.

Run `bun scripts/generate-brand.ts` to regenerate the app icons, favicon,
Apple touch icon and social preview. This optional asset task requires FFmpeg
with the `drawtext` filter and the DejaVu Sans font; neither is needed to run
the app. Maskable icons include extra padding for rounded and circular masks.

The [social preview](../../public/social-preview.png) is 1280 × 640 PNG,
under 1 MB. It is also the README banner. GitHub's repository preview is a
separate setting: open [repository settings](https://github.com/devswha/herdr-web-ui/settings),
then **Social preview → Edit → Upload an image** and select that file.
See [GitHub's instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).
