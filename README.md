# Lumen onboarding game

Author delivery: Lumen basic battles, 14 October 2026. Built from the approved archive with integrity checks; author text, game logic, progress and media are preserved. Telegram SDK and bridge are injected, and the sheet confirmation uses the same selection path as the result card.

Live site: https://piofant.github.io/lumen-onboarding-game/

Open from `/game` in `@lumen_charecter_bot` to send the selected companion into onboarding. The server issues an owner-bound launch; the client sends only `{v:1,launch,form}`. Browser scores and favorites do not become taste-profile data.

`manifest.json` records the source revision, source SHA-256 and hashes of the published files. Previous releases remain in git history. Never place user history, server state or launch capabilities in this repository.
