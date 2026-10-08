# Project notes for agents

## Refresh `prebuilt/` before every push

`prebuilt/gather-advisor.html` is the committed single-file build that users open directly; it
does not rebuild itself. Whenever a commit you push touches anything that ends up in the build
(`src/`, `index.html`, `sql/collect.sql`, `vite.config.ts`, dependencies), refresh it in the same
push:

```sh
npm run check                                   # typecheck + tests + build into dist/
cp dist/index.html prebuilt/gather-advisor.html
cp dist/collect.sql prebuilt/collect.sql        # the page links to ./collect.sql
git add prebuilt
```

Skip it only for changes that cannot affect the build (README, docs, tests).
